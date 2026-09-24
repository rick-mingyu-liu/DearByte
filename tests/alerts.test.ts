import { expect, test } from "vitest";
import { SEND_ALERT_GAP_MS, STUCK_MS, Watchdog } from "../src/alerts.ts";

function setup() {
  let now = 0;
  const alerts: string[] = [];
  const dog = new Watchdog({ notify: (title, body) => alerts.push(`${title}|${body}`), now: () => now });
  return { dog, alerts, advance: (ms: number) => (now += ms) };
}

test("a problem is alerted once it lasts a minute, then recovery is announced", () => {
  const { dog, alerts, advance } = setup();
  dog.check("chat closed");
  advance(STUCK_MS - 1);
  dog.check("chat closed");
  expect(alerts).toEqual([]);
  advance(1);
  dog.check("chat closed");
  advance(STUCK_MS * 5);
  dog.check("still closed");
  expect(alerts).toEqual(["小拜停了|chat closed"]);
  dog.check(null);
  expect(alerts[1]).toMatch(/^小拜恢复了/);
});

test("a blip that clears within the minute is never alerted", () => {
  const { dog, alerts, advance } = setup();
  dog.check("read failed");
  advance(30_000);
  dog.check(null);
  advance(40_000);
  dog.check("read failed");
  expect(alerts).toEqual([]);
});

test("send failures are alerted at most once per ten minutes", () => {
  const { dog, alerts, advance } = setup();
  dog.sendFailed("a");
  dog.sendFailed("b");
  advance(SEND_ALERT_GAP_MS);
  dog.sendFailed("c");
  expect(alerts).toEqual(["小拜有消息没发出去|a", "小拜有消息没发出去|c"]);
});
