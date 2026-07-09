import assert from "node:assert/strict";
import { test } from "node:test";
import { createUsageTimeRange, formatOpenAIUsageReport, OpenAIUsageService } from "../src/openai-usage.js";
import { createLoggerSpy, createSettings } from "./helpers/test-utils.js";

test("OpenAI usage service reports missing admin key without fetching", async () => {
  let fetchCalled = false;
  const service = new OpenAIUsageService(createSettings(), createLoggerSpy(), (async () => {
    fetchCalled = true;
    throw new Error("should not fetch");
  }) as typeof fetch);

  const report = await service.createReport();

  assert.equal(fetchCalled, false);
  assert.match(report, /openai\.adminApiKey in config\/settings\.json/);
});

test("OpenAI usage service aggregates costs and requests", async () => {
  const requests: URL[] = [];
  const service = new OpenAIUsageService(
    createSettings({
      openai: {
        adminApiKey: "admin-key",
        usageStartDate: "2026-01-01",
      },
    }),
    createLoggerSpy(),
    (async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);

      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.Authorization, "Bearer admin-key");
      assert.equal(url.searchParams.get("start_time"), "1767225600");

      if (url.pathname.endsWith("/organization/costs")) {
        return jsonResponse({
          data: [
            {
              results: [
                {
                  amount: {
                    value: 1.5,
                    currency: "usd",
                  },
                },
              ],
            },
            {
              results: [
                {
                  amount: {
                    value: 0.25,
                    currency: "usd",
                  },
                },
              ],
            },
          ],
          has_more: false,
        });
      }

      if (url.pathname.endsWith("/organization/usage/completions")) {
        return jsonResponse({
          data: [
            {
              results: [
                {
                  num_model_requests: 4,
                },
              ],
            },
            {
              results: [
                {
                  num_model_requests: 3,
                },
              ],
            },
          ],
          has_more: false,
        });
      }

      throw new Error(`Unexpected URL: ${url.href}`);
    }) as typeof fetch,
  );

  const report = await service.createReport();

  assert.equal(requests.length, 2);
  assert.match(report, /OpenAI usage \(Full configured range\)/);
  assert.match(report, /Time range: 2026-01-01T00:00:00Z to /);
  assert.match(report, /Total requests: 7/);
  assert.match(report, /Total cost: \$1\.75/);
  assert.match(report, /Cost per request: \$0\.2500/);
});

test("OpenAI usage formatting shows N/A cost per request when there are no requests", () => {
  const range = createUsageTimeRange("today", undefined, new Date("2026-05-29T13:00:00Z"));

  assert.deepEqual(range, {
    label: "Today",
    startTime: 1780012800,
    endTime: 1780059600,
  });

  assert.equal(
    formatOpenAIUsageReport({
      range,
      totalCost: 0,
      currency: "usd",
      totalRequests: 0,
    }),
    [
      "OpenAI usage (Today)",
      "Time range: 2026-05-29T00:00:00Z to 2026-05-29T13:00:00Z",
      "Total requests: 0",
      "Total cost: $0.0000",
      "Cost per request: N/A",
    ].join("\n"),
  );
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
