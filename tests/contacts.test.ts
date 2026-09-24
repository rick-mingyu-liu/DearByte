import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ROOT } from "../src/config.ts";
import { loadContacts, saveContacts } from "../src/contacts.ts";

const file = (content: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), "contacts-")), "contacts.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
};

test("a missing file means no contact yet", () => {
  expect(loadContacts(join(tmpdir(), "does-not-exist", "contacts.json"))).toBeNull();
});

test("saves and loads contacts; the committed example is valid", () => {
  const path = join(mkdtempSync(join(tmpdir(), "contacts-")), "sub", "contacts.json");
  saveContacts(path, [{ id: "me", names: ["张三", "Alex"] }]);
  expect(loadContacts(path)).toEqual([{ id: "me", names: ["张三", "Alex"] }]);
  expect(JSON.parse(readFileSync(path, "utf8")).contacts).toHaveLength(1);
  expect(loadContacts(join(ROOT, "contacts.example.json"))?.[0].names).toContain("张三");
});

test("rejects broken or ambiguous files with a readable reason", () => {
  expect(() => loadContacts(file("{"))).toThrow("不是合法的 JSON");
  expect(() => loadContacts(file({ contacts: [] }))).toThrow("格式不对");
  expect(() => loadContacts(file({ contacts: [{ id: "me", names: [] }] }))).toThrow("格式不对");
  expect(() => loadContacts(file({ contacts: [{ id: "Me Me", names: ["a"] }] }))).toThrow("格式不对");
  expect(() => loadContacts(file({ contacts: [{ id: "a", names: ["x"] }, { id: "a", names: ["y"] }] }))).toThrow("重复");
  expect(() => loadContacts(file({ contacts: [{ id: "a", names: ["x"] }, { id: "b", names: ["x"] }] }))).toThrow("两个联系人");
});
