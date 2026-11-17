// Cloudflare 무료 Workers 배포 준비 (wrangler 가 배포·dev 직전에 자동 실행).
//
// 1. worker/views/*.html  → worker/gen/templates.js  (화면 틀을 미리 번역: Workers 는 실행 중 코드 생성을 막음)
// 2. data/courses.json    → public/data/*.json       (구장 자료는 정적 파일로: 무료·무제한, Worker 요청 수를 아낌)
//                         → worker/gen/courses-lite.json (서버가 쓰는 최소 항목만)
// 3. static/*             → public/static/*
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...a) => path.join(ROOT, ...a);
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// 1. 화면 틀
nunjucks.installJinjaCompat();
// 파이썬(Jinja)처럼 빈 목록·빈 묶음을 '거짓'으로 보도록 if / 인라인 if / not 을 runtime.jt(...) 로 감싼다
// (runtime.jt 는 worker/lib.ts 에 있음)
const C = nunjucks.compiler.Compiler.prototype;
const origIf = C.compileIf;
C.compileIf = function (node, frame, async) {
  const emit = this._emit, emitLine = this._emitLine;
  let stage = 0;
  this._emit = function (s) {
    if (stage === 0 && s === "if(") { stage = 1; return emit.call(this, "if(runtime.jt("); }
    return emit.call(this, s);
  };
  this._emitLine = function (s) {
    if (stage === 1 && s === ") {") { stage = 2; return emitLine.call(this, ")) {"); }
    return emitLine.call(this, s);
  };
  try { return origIf.call(this, node, frame, async); } finally { delete this._emit; delete this._emitLine; }
};
C.compileInlineIf = function (node, frame) {
  this._emit("(runtime.jt(");
  this.compile(node.cond, frame);
  this._emit(")?");
  this.compile(node.body, frame);
  this._emit(":");
  if (node.else_ !== null) this.compile(node.else_, frame);
  else this._emit('""');
  this._emit(")");
};
C.compileNot = function (node, frame) {
  this._emit("!runtime.jt(");
  this.compile(node.target, frame);
  this._emit(")");
};
const views = p("worker", "views");
const parts = [];
for (const name of fs.readdirSync(views).filter((f) => f.endsWith(".html")).sort()) {
  const src = fs.readFileSync(path.join(views, name), "utf8");
  const code = nunjucks.compiler.compile(src, [], [], name, { autoescape: true });
  parts.push(`${JSON.stringify(name)}: (function() {\n${code}\n})()`);
}
write(p("worker", "gen", "templates.js"), `// 자동 생성 파일 (scripts/build-worker.mjs) — 직접 고치지 마세요\nexport default {\n${parts.join(",\n")}\n};\n`);

// 2. 구장 자료
const d = JSON.parse(fs.readFileSync(p("data", "courses.json"), "utf8"));
const LIST = ["id", "name", "sido", "sigungu", "address", "lat", "lng", "coord_source", "holes", "reserve_url", "phone",
  "reserve_phone", "operator", "reserve_level", "photo"];
const pick = (c, keys) => Object.fromEntries(keys.map((k) => [k, c[k] ?? null]));
fs.rmSync(p("public"), { recursive: true, force: true });
write(p("public", "data", "courses.json"), JSON.stringify(d.courses.map((c) => pick(c, LIST))));
for (const c of d.courses) write(p("public", "data", "course", `${c.id}.json`), JSON.stringify(c));
const counts = Object.fromEntries(d.sido_list.map((s) => [s, 0]));
for (const c of d.courses) counts[c.sido] = (counts[c.sido] || 0) + 1;
const built = new Date(fs.statSync(p("data", "courses.json")).mtimeMs + 9 * 3600e3).toISOString().slice(0, 10);
write(p("public", "data", "meta.json"), JSON.stringify({ total: d.courses.length, counts, sources: d.sources, built }));
write(p("worker", "gen", "courses-lite.json"), JSON.stringify(d.courses.map((c) =>
  pick(c, ["id", "name", "sido", "sigungu", "lat", "lng", "holes", "reserve_level", "reserve_url", "photo", "portal"]))));

// 3. 화면 꾸밈 파일
fs.cpSync(p("static"), p("public", "static"), { recursive: true });
console.log(`build-worker: 화면 ${parts.length}개, 구장 ${d.courses.length}곳 준비 완료`);
