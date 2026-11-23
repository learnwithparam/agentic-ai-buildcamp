// react-dom ships without types here. This is the one function the web page uses.
declare module "react-dom/server" {
  export function renderToStaticMarkup(node: unknown): string;
}
