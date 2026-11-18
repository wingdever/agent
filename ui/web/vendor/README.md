# Vendored browser libraries

These files are checked in because the web UI has no build step and must work
offline (Electron `file://`).

| File | Package | Version | License |
|---|---|---|---|
| `marked.umd.js` | [marked](https://github.com/markedjs/marked) | 18.1.2 | MIT |
| `purify.min.js` | [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.17 | Apache-2.0 OR MPL-2.0 |
| `cytoscape.min.js` | [cytoscape](https://github.com/cytoscape/cytoscape.js) | 3.35.0 | MIT |
| `cytoscape-dagre.js` | [cytoscape-dagre](https://github.com/cytoscape/cytoscape.js-dagre) | 3.0.0 | MIT |

Each file keeps its upstream license banner. Do not edit them by hand; update
the pinned version and re-copy from the npm package/CDN when upgrading.
