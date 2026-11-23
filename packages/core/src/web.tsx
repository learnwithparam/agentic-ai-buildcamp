// biome-ignore-all lint/style/useNamingConvention: json-render part names are PascalCase
// The web surface. It draws a chart spec with the shadcn parts of json-render.
// The same spec feeds the terminal, so a chart looks the same in both places.
import { defineCatalog, type Spec } from "@json-render/core";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import { shadcnComponents } from "@json-render/shadcn";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { renderToStaticMarkup } from "react-dom/server";

// #region step:surfaces
const definitions = shadcnComponentDefinitions;
const catalog = defineCatalog(schema, {
  components: {
    Card: definitions.Card,
    Stack: definitions.Stack,
    Heading: definitions.Heading,
    Text: definitions.Text,
    Table: definitions.Table,
    Progress: definitions.Progress,
  },
  actions: {},
});

const { registry } = defineRegistry(catalog, {
  components: {
    Card: shadcnComponents.Card,
    Stack: shadcnComponents.Stack,
    Heading: shadcnComponents.Heading,
    Text: shadcnComponents.Text,
    Table: shadcnComponents.Table,
    Progress: shadcnComponents.Progress,
  },
});

// The React part: Agent Chat UI can mount this to show a chart under the words.
export function ChartView(props: { spec: Spec }) {
  return (
    <JSONUIProvider registry={registry}>
      <Renderer spec={props.spec} registry={registry} />
    </JSONUIProvider>
  );
}

// A full page for screenshots. Tailwind loads in the browser because the shadcn parts use it.
const TAILWIND = "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.11";

export function chartPage(title: string, spec: Spec): string {
  const body = renderToStaticMarkup(<ChartView spec={spec} />);
  const script = `<script src="${TAILWIND}"></script>`;
  const head = `<meta charset="utf-8"><title>${title}</title>${script}`;
  const page = `<head>${head}</head><body class="p-6">${body}</body>`;
  return `<!doctype html><html lang="en">${page}</html>`;
}
// #stub
//~ // TODO(surfaces): draw the chart spec with the shadcn parts of json-render
//~ export function chartPage(title: string, _spec: Spec): string {
//~   return `<!doctype html><title>${title}</title>`;
//~ }
// #endregion
