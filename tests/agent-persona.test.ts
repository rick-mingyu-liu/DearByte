import { expect, test } from "vitest";
import { agentSystemPrompt, PERSONAS, withCurrentTime } from "../src/agent/persona.ts";
import { loadConfig, ROOT } from "../src/config.ts";

test("every persona loads, with the shared rules after it", () => {
  for (const persona of PERSONAS) {
    const system = agentSystemPrompt(ROOT, persona);
    expect(system).toContain("# Rules that apply whatever your persona");
    expect(system.indexOf("# Rules that apply")).toBeGreaterThan(system.length / 3);
  }
});

test("default is DearByte in English, a friend and never a partner, with US crisis resources", () => {
  const system = agentSystemPrompt(ROOT, "default");
  expect(system).toMatch(/^# Who you are: DearByte/);
  expect(system).toContain("never a romantic partner");
  expect(system).toContain("988");
  expect(system).not.toContain("小拜");
});

test("xiaobai is the opt-in Chinese pack, with China's crisis numbers", () => {
  const system = agentSystemPrompt(ROOT, "xiaobai");
  expect(system).toMatch(/^# 角色：小拜/);
  expect(system).toContain("12356");
});

test("examples reach the prompt without their author notes", () => {
  const system = agentSystemPrompt(ROOT, "default");
  expect(system).toContain("# Examples of your tone");
  expect(system).toContain("User: do you love me");
  expect(system).not.toContain("Warm but clearly not romantic"); // a `note`
  expect(system).not.toContain("_readme");
});

test("money rules hold for every persona", () => {
  for (const persona of PERSONAS) {
    expect(agentSystemPrompt(ROOT, persona)).toContain("You can only propose a purchase or booking.");
  }
});

test("the system prompt is the same every time, so it stays cached; the time goes in the message", () => {
  expect(agentSystemPrompt(ROOT, "default")).toBe(agentSystemPrompt(ROOT, "default"));
  expect(agentSystemPrompt(ROOT, "default")).not.toMatch(/\b20\d\d\b/);
  const text = withCurrentTime("hey", new Date("2026-09-26T16:05:00Z"), "America/Los_Angeles");
  expect(text).toBe("[Now: Saturday, Sep 26, 2026, 9:05 AM, America/Los_Angeles]\nhey");
});

test("DEARBYTE_PERSONA picks the persona; default when unset, explained when unknown", () => {
  expect(loadConfig({ DEARBYTE_PERSONA: "" }).agentPersona).toBe("default");
  expect(loadConfig({ DEARBYTE_PERSONA: "Xiaobai" }).agentPersona).toBe("xiaobai");
  expect(loadConfig({ DEARBYTE_PERSONA: "girlfriend" }).agentPersona).toMatchObject({ problem: expect.stringContaining("default, xiaobai") });
});
