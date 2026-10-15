// A local regression host for the actual recorder page. No capture, model,
// credential or permission APIs. The runner supplies an isolated loopback URL.
import AppKit
import WebKit

@MainActor final class PlaybackHost: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var started = false
    var shell: MeetingArchiveShell?
    var measurements: [[String: Any]] = []
    let args = CommandLine.arguments
    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name:"meetingArchiveState")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1120, height: 900), configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "MinuteShelf — isolated playback regression"
        if args.contains("--native-shell") {
            shell = MeetingArchiveShell(web:web, window:window)
            shell!.split.splitView.autosaveName = nil
            shell!.setInteractionEnabled(true)
        } else { window.contentView = web }
        window.center(); window.makeKeyAndOrderFront(nil)
        web.load(URLRequest(url: URL(string: args[1])!))
    }
    func script(_ source: String, _ arguments: [String: Any] = [:]) async throws -> Any? {
        try await web.callAsyncJavaScript(source, arguments: arguments, in: nil, contentWorld: .page)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !started else { return }; started = true
        Task {
            do {
                let deadline = Date().addingTimeInterval(15)
                while try await script("return typeof connected !== 'undefined' && connected") as? Bool != true {
                    guard Date() < deadline else { throw NSError(domain: "PlaybackTest", code: 1) }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                if shell != nil { try await script("return window.MeetingArchiveDesktop.enableNativeShell()") }
                try await script("await openMeeting(id); selectMeetingTab('playback'); return true", ["id": args[2]])
                let preparedDeadline = Date().addingTimeInterval(180)
                while try await script("return meetingPlayback?.status === 'video-only' || (meetingPlayback?.status === 'ready' && audioReady?.loaded)") as? Bool != true {
                    guard Date() < preparedDeadline else { throw NSError(domain:"PlaybackTest",code:3,userInfo:[NSLocalizedDescriptionKey:"Continuous audio preparation timed out"]) }
                    try await Task.sleep(nanoseconds:500_000_000)
                    let failure = try await script("return ['failed','interrupted','blocked'].includes(meetingPlayback?.status) ? JSON.stringify(meetingPlayback) : ''") as? String ?? ""
                    if !failure.isEmpty { throw NSError(domain:"PlaybackTest",code:4,userInfo:[NSLocalizedDescriptionKey:failure]) }
                }
                if args.contains("--continuous-audio") { try await continuousAudio(); finish(nil); return }
                try await script("window.__playbackEvents=[]; const v=document.getElementById('video'); for(const name of ['loadstart','loadedmetadata','loadeddata','canplay','seeked','waiting','stalled','error','emptied']) v.addEventListener(name,()=>{window.__playbackEvents.push({name,time:v.currentTime,readyState:v.readyState,networkState:v.networkState}); if(window.__playbackEvents.length>80) window.__playbackEvents.shift();}); return true")
                // Direct paused seeks before, inside, and after Testing3's gap;
                // then the same path while the meeting transport is playing.
                for (name, position, playing) in [("before-gap", 1.0, false), ("inside-gap", 30.0, false), ("after-gap-paused", 50.0, false), ("inside-gap-playing", 30.0, true), ("after-gap-playing", 50.0, true)] {
                    try await script("await seek(position, playing); const v=document.getElementById('video'); (v.hidden ? document.getElementById('video-gap') : v).scrollIntoView({block:'center'}); return true", ["position": position, "playing": playing])
                    try await Task.sleep(nanoseconds: 1_500_000_000)
                    var state = try await script("const v=document.getElementById('video'), r=v.getBoundingClientRect(); let pixels=null, pixelError=null; if(!v.hidden && v.videoWidth && v.readyState>=2) {try {const c=document.createElement('canvas'); c.width=32;c.height=32;const ctx=c.getContext('2d');ctx.drawImage(v,0,0,32,32);const data=ctx.getImageData(0,0,32,32).data;let sum=0; for(let i=0;i<data.length;i+=4) sum+=data[i]+data[i+1]+data[i+2]; pixels=sum/(32*32*3);}catch(e){pixelError=e.name;}} return {name,hidden:v.hidden,readyState:v.readyState,networkState:v.networkState,videoWidth:v.videoWidth,videoHeight:v.videoHeight,currentTime:v.currentTime,seeking:v.seeking,paused:v.paused,ended:v.ended,buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)]),seekable:Array.from({length:v.seekable.length},(_,i)=>[v.seekable.start(i),v.seekable.end(i)]),canvasMeanRGB:pixels,pixelError,rect:{x:r.x,y:r.y,width:r.width,height:r.height},events:window.__playbackEvents};", ["name": name]) as! [String: Any]
                    let snapshot = try await snapshot()
                    let image = NSBitmapImageRep(data: snapshot.tiffRepresentation!)!
                    let rect = state["rect"] as! [String: Any]
                    let x = (rect["x"] as! Double) + (rect["width"] as! Double) / 2
                    let y = (rect["y"] as! Double) + (rect["height"] as! Double) / 2
                    let px = max(0, min(image.pixelsWide-1, Int(x * Double(image.pixelsWide) / web.bounds.width)))
                    let py = max(0, min(image.pixelsHigh-1, Int(y * Double(image.pixelsHigh) / web.bounds.height)))
                    if let color = image.colorAt(x:px, y:py)?.usingColorSpace(.deviceRGB) { state["snapshotCenterRGB"] = [color.redComponent * 255, color.greenComponent * 255, color.blueComponent * 255] }
                    let url = URL(fileURLWithPath: args[3]).appendingPathComponent(name + ".png")
                    try image.representation(using:.png, properties:[:])!.write(to:url)
                    measurements.append(state)
                }
                try await script("pauseRawPlayback(); return true")
                finish(nil)
            } catch { finish(error) }
        }
    }
    func continuousAudio() async throws {
        // Observe decoded output before a zero-gain destination. This checks
        // actual WebKit audio without playing private meeting content aloud.
        let state = try await script("const a=document.getElementById('meeting-audio'); window.__ctx=new AudioContext(); window.__analyser=__ctx.createAnalyser();__analyser.fftSize=2048;const input=__ctx.createMediaElementSource(a), mute=__ctx.createGain();mute.gain.value=0;input.connect(__analyser);__analyser.connect(mute);mute.connect(__ctx.destination);window.__audioEvents=[];for(const name of ['loadstart','seeking','waiting','stalled','error']) a.addEventListener(name,()=>__audioEvents.push({name,time:a.currentTime}));await Promise.race([__ctx.resume(),new Promise(r=>setTimeout(r,1500))]);return __ctx.state;") as? String
        guard state == "running" else { throw NSError(domain:"PlaybackTest",code:5,userInfo:[NSLocalizedDescriptionKey:"Web Audio did not start"]) }
        for point in [1.0,1445.0,1475.0,1545.0,2436.0,4145.0] {
            try await script("await seek(point,true);return true",["point":point])
            try await Task.sleep(nanoseconds:650_000_000)
            measurements.append(try await audioMeasurement("seek", expected:point))
        }
        try await script("await seek(2430,true);return true")
        try await Task.sleep(nanoseconds:1_500_000_000)
        try await script("window.__audioEvents=[]; return true")
        for _ in 0..<120 {
            try await Task.sleep(nanoseconds:250_000_000)
            measurements.append(try await audioMeasurement("continuous", expected:0))
        }
        let rows=measurements.filter { $0["name"] as? String == "continuous" }
        let times=rows.compactMap { $0["audioTime"] as? Double }
        guard let first=times.first, let last=times.last, last-first>28 else { throw NSError(domain:"PlaybackTest",code:6,userInfo:[NSLocalizedDescriptionKey:"Audio clock did not advance continuously"]) }
        let seeks=try await script("return __audioEvents.filter(e=>e.name==='seeking'||e.name==='loadstart'||e.name==='error')") as? [[String:Any]] ?? []
        guard seeks.isEmpty else { throw NSError(domain:"PlaybackTest",code:7,userInfo:[NSLocalizedDescriptionKey:"Audio reloaded or sought during continuous playback"]) }
        let files=Set(rows.compactMap { $0["videoFile"] as? String })
        guard files.count>=3 else { throw NSError(domain:"PlaybackTest",code:8,userInfo:[NSLocalizedDescriptionKey:"Video boundaries were not exercised"]) }
        let rms=rows.compactMap { $0["audioRMS"] as? Double }
        guard rms.filter({$0>0.00001}).count>80 else { throw NSError(domain:"PlaybackTest",code:9,userInfo:[NSLocalizedDescriptionKey:"WebKit output was unexpectedly silent"]) }
        guard Set(rms).count>80 else { throw NSError(domain:"PlaybackTest",code:10,userInfo:[NSLocalizedDescriptionKey:"WebKit analyser returned stale audio samples"]) }
        try await script("pauseRawPlayback(); document.getElementById('video').scrollIntoView({block:'center'}); return true")
        let image=NSBitmapImageRep(data:try await snapshot().tiffRepresentation!)!
        try image.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:args[3]).appendingPathComponent("continuous-playback.png"))
    }
    func audioMeasurement(_ name:String, expected:Double) async throws -> [String:Any] {
        try await script("const a=document.getElementById('meeting-audio'), v=document.getElementById('video'), samples=new Float32Array(__analyser.fftSize);__analyser.getFloatTimeDomainData(samples);return {name,expected,audioTime:a.currentTime,audioRMS:Math.sqrt(samples.reduce((s,x)=>s+x*x,0)/samples.length),paused:a.paused,seeking:a.seeking,audioURL:a.currentSrc,videoFile:sourceClip?.file||'',videoMuted:v.muted,position:Number(document.getElementById('timeline').value),audioEvents:__audioEvents.slice(-8)}",["name":name,"expected":expected]) as! [String:Any]
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let value = message.body as? [String:Any], let state = ArchiveShellSnapshot(value) { shell?.apply(state) }
    }
    func snapshot() async throws -> NSImage {
        try await withCheckedThrowingContinuation { continuation in
            web.takeSnapshot(with:nil) { image, error in
                if let image { continuation.resume(returning:image) }
                else { continuation.resume(throwing:error ?? NSError(domain:"PlaybackTest",code:2)) }
            }
        }
    }
    func finish(_ error: Error?) {
        let report: [String: Any] = ["webKit":true,"nativeShell":shell != nil,"actualCapture":false,"requestedPermissions":false,"measurements":measurements,"error":error?.localizedDescription ?? ""]
        if let data = try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]) { try? data.write(to:URL(fileURLWithPath:args[3]).appendingPathComponent("webkit-report.json")) }
        exit(error == nil ? 0 : 2)
    }
}
@main struct Main {
    @MainActor static func main() { let app=NSApplication.shared, host=PlaybackHost(); app.setActivationPolicy(.regular); app.delegate=host; app.run() }
}
