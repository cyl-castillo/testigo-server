import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JsonDetail } from "../ui/JsonDetail.js";
for (const label of ["event", "request"])
  test(`${label} detail renders malicious HTML as inert text`, () => {
    const value = {
      command: "<script>window.pwned=1</script>",
      message: '<img src=x onerror="alert(1)">',
      context: '</pre><iframe src="https://attacker.invalid"></iframe>',
    };
    const rendered = renderToStaticMarkup(
      createElement(JsonDetail, { value, testId: `${label}-input` }),
    );
    assert.match(rendered, /&lt;script&gt;/);
    assert.match(rendered, /&lt;img/);
    assert.match(rendered, /&lt;\/pre&gt;/);
    assert.doesNotMatch(rendered, /<script|<img|<iframe/i);
  });
