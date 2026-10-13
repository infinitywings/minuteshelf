import Foundation

// Public documentation is discovery metadata, not proof that an account can use
// a model. It is never interpreted as instructions or used to construct URLs.
enum ClaudePublishedModels {
    private static let catalogURL = URL(string: "https://platform.claude.com/docs/en/models/overview.md")!
    private static let maximumBytes = 1_048_576
    private static let maximumLineBytes = 16_384
    private static let maximumModels = 64

    private enum FetchError: LocalizedError {
        case unavailable
        var errorDescription: String? {
            "The published Claude model list could not be refreshed. Your saved selection is unchanged."
        }
    }

    private final class PublicDocumentDelegate: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask,
                        didReceive challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            // Keep normal TLS verification, but never supply a credential to
            // this unauthenticated public-document request.
            completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
                ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
        }
    }

    static func fetch() async throws -> [ModelCatalogEntry] {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration, delegate: PublicDocumentDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }

        var request = URLRequest(url: catalogURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.setValue("text/markdown, text/plain", forHTTPHeaderField: "Accept")
        do {
            try Task.checkCancellation()
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.url == catalogURL,
                  response.expectedContentLength <= Int64(maximumBytes) else { throw FetchError.unavailable }
            var data = Data()
            data.reserveCapacity(16_384)
            for try await byte in bytes {
                guard data.count < maximumBytes else { throw FetchError.unavailable }
                data.append(byte)
                if data.count.isMultiple(of: 4096) { try Task.checkCancellation() }
            }
            try Task.checkCancellation()
            guard let markdown = String(data: data, encoding: .utf8) else { throw FetchError.unavailable }
            return try parseMarkdown(markdown)
        } catch {
            if Task.isCancelled { throw CancellationError() }
            // Do not expose response bodies, unexpected locations, or raw
            // network error details in the settings UI.
            throw FetchError.unavailable
        }
    }

    static func parseMarkdown(_ markdown: String) throws -> [ModelCatalogEntry] {
        guard !markdown.isEmpty, markdown.utf8.count <= maximumBytes else { throw ModelCatalogError.invalid }
        var models: [ModelCatalogEntry] = []
        var seen = Set<String>()
        var header: [String]?
        var needsSeparator = false
        var validSeparator = false
        var foundIDRow = false
        var fence: (marker: Character, count: Int)?
        var inComment = false

        func resetTable() {
            header = nil; needsSeparator = false; validSeparator = false; foundIDRow = false
        }

        // Swift treats CRLF as a single Character, so normalize it before
        // splitting on the newline Character.
        for rawLine in markdown.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            guard rawLine.utf8.count <= maximumLineBytes else { throw ModelCatalogError.invalid }
            var line = String(rawLine)
            if line.hasSuffix("\r") { line.removeLast() }
            line = line.trimmingCharacters(in: .whitespaces)

            if let current = fence {
                let prefix = line.prefix(while: { $0 == current.marker })
                if prefix.count >= current.count,
                   line.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces).isEmpty { fence = nil }
                resetTable(); continue
            }
            if inComment || line.contains("<!--") {
                // Commented-out examples are not a published model table.
                if let start = line.range(of: "<!--"), !inComment {
                    inComment = line.range(of: "-->", range: start.upperBound..<line.endIndex) == nil
                } else if line.contains("-->") { inComment = false }
                resetTable(); continue
            }
            if let marker = line.first, marker == "`" || marker == "~" {
                let count = line.prefix(while: { $0 == marker }).count
                if count >= 3 { fence = (marker, count); resetTable(); continue }
            }

            let parts = line.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
            let firstCell = parts.first(where: { !$0.isEmpty })
            let isIDRow = firstCell == "Claude API ID"
            guard line.hasPrefix("|"), line.hasSuffix("|"), parts.count >= 3 else {
                if isIDRow { throw ModelCatalogError.invalid }
                resetTable(); continue
            }
            let cells = Array(parts.dropFirst().dropLast())
            if cells.first == "Feature" {
                // A second header inside one table would make column matching
                // ambiguous. Separate tables require a normal block boundary.
                guard header == nil, cells.count >= 2, cells.count <= maximumModels + 1 else {
                    throw ModelCatalogError.invalid
                }
                header = Array(cells.dropFirst())
                needsSeparator = true; validSeparator = false; foundIDRow = false
                continue
            }
            if needsSeparator {
                needsSeparator = false
                validSeparator = cells.count == (header?.count ?? 0) + 1 && cells.allSatisfy { cell in
                    cell.range(of: #"\A:?-{3,}:?\z"#, options: .regularExpression) != nil
                }
                if !isIDRow { continue }
            }
            guard isIDRow else { continue }
            guard let names = header, validSeparator, !foundIDRow, cells.count == names.count + 1 else {
                throw ModelCatalogError.invalid
            }
            foundIDRow = true
            for (name, cell) in zip(names, cells.dropFirst()) {
                guard name.utf8.count <= 100,
                      name.range(of: #"\AClaude [A-Za-z0-9][A-Za-z0-9 ._-]*\z"#, options: .regularExpression) != nil,
                      cell.utf8.count <= 130,
                      cell.range(of: #"\A`claude-[a-z0-9]+(?:-[a-z0-9]+)*`\z"#, options: .regularExpression) != nil else {
                    throw ModelCatalogError.invalid
                }
                let id = String(cell.dropFirst().dropLast())
                guard seen.insert(id).inserted, models.count < maximumModels else { throw ModelCatalogError.invalid }
                // The selected rows do not attest input capabilities or plan
                // access. Leave modalities unspecified rather than infer them.
                models.append(.init(id: id, displayName: name, inputModalities: []))
            }
        }
        guard !models.isEmpty else { throw ModelCatalogError.invalid }
        return models
    }
}
