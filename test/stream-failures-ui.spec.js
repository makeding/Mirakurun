/*
   Copyright 2026 kanreisa

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");

test("stream history loading stays inline instead of covering the home page", () => {
    const filename = require.resolve("../src/ui/components/StreamFailures.tsx");
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
        fileName: filename,
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React }
    });
    const exports = {};
    // Styles are loaded by webpack; render the actual component with real React
    // hooks and Blueprint components, without running its network effects.
    new Function("require", "exports", outputText)(
        name => name.endsWith(".sass") ? {} : require(name), exports
    );
    const html = renderToStaticMarkup(React.createElement(exports.StreamFailures));
    assert.match(html, /失敗履歴を読み込んでいます/);
    assert.match(html, /stream-failures-state/);
    // Global NonIdealState styles are page overlays in this application.
    assert.doesNotMatch(html, /bp5-non-ideal-state/);
    assert.doesNotMatch(html, /信号と接続を確認して/);
});
