import { describe, expect, it } from "vitest";
import { readUrlAttribution } from "./attribution";

describe("readUrlAttribution", () => {
  it("accepts the new parameter names", () => {
    expect(
      readUrlAttribution("?manychat_id=123456&instagram_id=some.user&utm_source=ig"),
    ).toMatchObject({
      manychat_id: "123456",
      instagram_id: "some.user",
      utm_source: "ig",
    });
  });
  it("maps the legacy ManyChat names (m_id -> manychat_id, handle -> instagram_id)", () => {
    expect(readUrlAttribution("?m_id=123456&handle=some.user")).toMatchObject({
      manychat_id: "123456",
      instagram_id: "some.user",
    });
  });
  it("prefers the new names when both are present", () => {
    expect(readUrlAttribution("?m_id=111&manychat_id=222&handle=a&instagram_id=b")).toMatchObject({
      manychat_id: "222",
      instagram_id: "b",
    });
  });
  it("treats the legacy placeholder unknown and empty values as absent", () => {
    expect(readUrlAttribution("?m_id=unknown&handle=Unknown")).toMatchObject({
      manychat_id: null,
      instagram_id: null,
    });
    expect(readUrlAttribution("?m_id=&handle=%20")).toMatchObject({
      manychat_id: null,
      instagram_id: null,
    });
    expect(readUrlAttribution("?manychat_id=unknown&m_id=555")).toMatchObject({
      manychat_id: "555",
    });
  });
  it("trims and caps values at 120 characters", () => {
    expect(readUrlAttribution(`?m_id=${"9".repeat(300)}`).manychat_id).toHaveLength(120);
    expect(readUrlAttribution("?m_id=%20%2012%20").manychat_id).toBe("12");
  });
  it("returns nulls without parameters", () => {
    expect(readUrlAttribution("")).toEqual({
      utm_source: null,
      utm_campaign: null,
      instagram_id: null,
      manychat_id: null,
    });
  });
});
