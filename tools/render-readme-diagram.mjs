// Editable, dependency-free README diagram. Provider details belong in README.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const destination = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/assets/minuteshelf-workflow.svg');
const colors = { paper: '#F8F7F2', ink: '#29352A', muted: '#737B6D', green: '#52683B', tint: '#EFF3E7', line: '#DAE0D3', arrow: '#899C70' };
const elements = [];
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const text = (x, y, label, className, attributes = '') => elements.push(`<text x="${x}" y="${y}" class="${className}" ${attributes}>${escape(label)}</text>`);
const box = (x, y, width, height, fill = '#FFFFFF', stroke = colors.line, radius = 24) => {
  if (x < 0 || y < 0 || x + width > 1440 || y + height > 850) throw new Error('Box is outside the diagram.');
  elements.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`);
};
const line = (d, className = 'arrow', marker = true) => elements.push(`<path d="${d}" class="${className}"${marker ? ' marker-end="url(#arrowhead)"' : ''}/>`);
const icon = (x, y, type, stroke = colors.green) => {
  const shapes = {
    audio: '<path d="M1 15v6M8 8v20M15 1v34M22 8v20M29 15v6"/>',
    screen: '<rect x="1" y="2" width="32" height="23" rx="3"/><path d="M10 34h14M17 25v9"/>',
    documents: '<path d="M6 2h15l9 9v25H6ZM21 2v9h9M12 18h12M12 25h12"/>',
    folder: '<path d="M1 10V6a4 4 0 0 1 4-4h11l5 6h15a4 4 0 0 1 4 4v25a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4Z"/>',
    play: '<circle cx="17" cy="17" r="16"/><path d="m13 9 12 8-12 8Z"/>',
    project: '<rect x="1" y="1" width="12" height="12" rx="3"/><rect x="21" y="1" width="12" height="12" rx="3"/><rect x="1" y="21" width="12" height="12" rx="3"/><rect x="21" y="21" width="12" height="12" rx="3"/>',
    export: '<path d="M17 22V1m-8 8 8-8 8 8M1 19v13h32V19"/>',
  };
  elements.push(`<g transform="translate(${x} ${y})" fill="none" stroke="${stroke}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${shapes[type]}</g>`);
};

text(80, 54, 'MINUTESHELF', 'brand');
text(80, 106, 'Record. Understand. Revisit.', 'title');

text(80, 163, '01  RECORD', 'step');
box(80, 186, 725, 122);
elements.push(`<path d="M442 210V284" stroke="${colors.line}"/>`);
icon(215, 208, 'audio');
text(270, 233, 'Audio', 'input');
icon(570, 208, 'screen');
text(627, 233, 'Screen', 'input');
// The recording-source box supplies both AI inputs and untouched originals.
line('M260 308V385');
line('M645 308V385');
line('M80 247H42V753H69', 'originals');

box(1015, 186, 325, 122);
icon(1050, 217, 'documents');
text(1109, 231, 'Documents', 'input');
text(1109, 265, 'Context', 'secondary');
line('M1177 308V385');

text(80, 367, '02  UNDERSTAND', 'step');
box(100, 396, 320, 136);
text(132, 455, 'STT', 'module');
text(132, 497, 'Transcript', 'secondary');
box(485, 396, 320, 136);
text(517, 455, 'VLM', 'module');
text(517, 497, 'Visual evidence', 'secondary');
box(1015, 396, 325, 136, colors.tint);
text(1047, 455, 'LLM', 'module');
text(1047, 497, 'Meeting notes', 'secondary');

// STT and VLM feed the summarizer independently; they are not sequential models.
line('M805 440H1004');
line('M260 532V584H944V490H1004');
line('M1177 532V699');
text(80, 637, 'Choose each model independently.', 'caption');
text(1340, 637, 'Local or cloud', 'caption', 'text-anchor="end"');

text(80, 692, '03  REVISIT', 'step');
box(80, 710, 1260, 112, colors.green, colors.green);
icon(111, 744, 'folder', '#EBF0E3');
text(174, 755, 'One meeting folder', 'archivetitle');
text(174, 789, 'Originals + evidence + notes', 'archivesubtitle');
icon(725, 749, 'play', '#EBF0E3');
text(772, 773, 'Playback', 'archiveaction');
icon(943, 749, 'project', '#EBF0E3');
text(991, 773, 'Projects', 'archiveaction');
icon(1152, 749, 'export', '#EBF0E3');
text(1200, 773, 'Export', 'archiveaction');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="850" viewBox="0 0 1440 850" role="img" aria-labelledby="diagram-title diagram-description">
  <title id="diagram-title">MinuteShelf: Record, understand, and revisit</title>
  <desc id="diagram-description">Audio goes to STT for a transcript. Selected screen frames go to a VLM for visual evidence. These results, plus documents and context, feed a separately chosen LLM for meeting notes. Original recordings and analysis outputs belong to one meeting archive with playback, project grouping, and export. Each model can be selected independently.</desc>
  <defs><marker id="arrowhead" markerWidth="10" markerHeight="10" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L8 4L0 8" fill="none" stroke="${colors.arrow}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: ${colors.ink}; }
    .brand { font-size: 15px; font-weight: 750; letter-spacing: 2.3px; fill: ${colors.green}; }
    .title { font-size: 42px; font-weight: 650; letter-spacing: -1.3px; }
    .step { font-size: 16px; font-weight: 750; letter-spacing: 1.7px; fill: ${colors.green}; }
    .input { font-size: 25px; font-weight: 600; }
    .module { font-size: 43px; font-weight: 700; letter-spacing: -.7px; fill: ${colors.green}; }
    .secondary { font-size: 22px; fill: ${colors.muted}; }
    .caption { font-size: 21px; fill: ${colors.muted}; }
    .archivetitle { font-size: 25px; font-weight: 650; fill: #FFFFFF; }
    .archivesubtitle { font-size: 19px; fill: #DFE7D5; }
    .archiveaction { font-size: 22px; font-weight: 550; fill: #FFFFFF; }
    .arrow { fill: none; stroke: ${colors.arrow}; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .originals { fill: none; stroke: ${colors.arrow}; stroke-width: 2; stroke-dasharray: 5 7; stroke-linecap: round; stroke-linejoin: round; }
  </style>
  <rect width="1440" height="850" rx="28" fill="${colors.paper}"/>
  ${elements.join('\n  ')}
</svg>
`;
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, svg);
console.log(destination);
