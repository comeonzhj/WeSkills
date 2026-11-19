import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build, transform } from "esbuild";

const directory = "public/assets";
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });

async function asset(extension, body) {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const name = `/assets/app.${hash}.${extension}`;
  await writeFile(`public${name}`, body);
  return name;
}

const css = await Promise.all(["zed-tokens.css", "app.css"].map(file => readFile(`public/${file}`, "utf8")));
const scripts = await Promise.all(["copy.js", "fold.js", "dismiss.js", "interaction.js"].map(file => readFile(`public/${file}`, "utf8")));
const client = await transform(scripts.join(";\n"), { minify: true, target: "es2022" });
const assets = {
  css: await asset("css", css.join("\n")),
  js: await asset("js", client.code),
  logo: await asset("png", await readFile("public/logo.png")),
};

await build({
  entryPoints: ["server/main.mjs"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/server.cjs",
  define: { __WS_ASSETS__: JSON.stringify(assets) },
});
