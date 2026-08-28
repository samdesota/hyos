export function renderIterationOverlayHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HyOS UI Agent</title>
    <link rel="stylesheet" href="./overlay.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./overlay.js"></script>
  </body>
</html>`;
}
