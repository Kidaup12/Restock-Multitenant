/**
 * The forecast run now lives in @wezesha/forecast-run so the worker's nightly
 * cron and this app's manual "Re-run now" call the exact same pipeline — one
 * engine, one number (spec §6). This module stays as the app's import site.
 */
export { runForecast, type ForecastRunResult } from "@wezesha/forecast-run";
