import { describe, expect, it } from "vitest";
import { crashed, redirectTarget } from "../scripts/smoke-detect.mjs";

/**
 * The smoke's crash detector, and why it had to be loosened carefully.
 *
 * It used to treat the bare word "digest" as proof of a crash. `redirect()` and
 * `notFound()` are implemented as thrown errors, so a page that forwards
 * correctly carries `data-next-error-digest="NEXT_REDIRECT;..."` — which meant
 * four healthy routes and every forwarder in the app read as broken. A check
 * that cries wolf is a check people learn to skip.
 *
 * Loosening a detector is where coverage quietly disappears, so both directions
 * are pinned here: control flow must pass, and a real server-side exception
 * must still be caught.
 */

const shell = (inner: string) => `<html><body><div>${inner}</div></body></html>`;

describe("telling a crash from a redirect", () => {
  it("lets a redirect through", () => {
    const body = shell(
      `<template data-next-error-message="NEXT_REDIRECT" data-next-error-digest="NEXT_REDIRECT;replace;/today;307;"></template>`
    );
    expect(crashed(body), "a page that forwarded was reported as crashed").toBeNull();
  });

  it("lets a not-found through", () => {
    const body = shell(`<template data-next-error-digest="NEXT_HTTP_ERROR_FALLBACK;404"></template>`);
    expect(crashed(body)).toBeNull();
  });

  it("still catches a real server-side exception", () => {
    // The shape Next gives a genuine throw: an opaque hash, no NEXT_ prefix.
    const body = shell(`<template data-next-error-digest="3751048163"></template>`);
    expect(crashed(body), "a real crash slipped past the detector").toBe("error digest 3751048163");
  });

  it("still catches the rendered error boundary", () => {
    expect(crashed(shell("<h2>Something went wrong</h2>"))).toBe("Something went wrong");
    expect(crashed(shell("<h2>Application error</h2>"))).toBe("Application error");
  });

  it("passes a clean page", () => {
    expect(crashed(shell("<h1>Today</h1>"))).toBeNull();
  });
});

describe("finding where a page forwarded to", () => {
  it("reads an HTTP Location", () => {
    expect(redirectTarget({ status: 307, location: "/today", body: "" })).toBe("/today");
  });

  it("reads a redirect thrown after the shell was flushed", () => {
    // A page-level redirect inside a streamed route arrives in the payload with
    // no Location header at all. The forwarder still works in a browser, so a
    // check that only looked at the status called two healthy routes broken.
    const body = `self.__next_f.push([1,"1e7:E{\\"digest\\":\\"NEXT_REDIRECT;replace;/products;308;\\"}"])`;
    expect(redirectTarget({ status: 200, location: null, body })).toBe("/products");
  });

  it("says nothing when a page simply rendered", () => {
    expect(redirectTarget({ status: 200, location: null, body: shell("<h1>Products</h1>") })).toBeNull();
  });
});
