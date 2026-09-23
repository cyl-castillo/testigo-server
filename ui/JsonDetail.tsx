import React from "react";
/** Render untrusted JSON as text. Never interpret submitted content as HTML. */
export function JsonDetail({
  value,
  testId,
}: {
  value: unknown;
  testId?: string;
}) {
  return <pre data-testid={testId}>{JSON.stringify(value, null, 2)}</pre>;
}
