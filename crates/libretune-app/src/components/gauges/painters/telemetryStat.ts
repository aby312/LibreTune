/**
 * TelemetryStat — flat, modern stat tile (LibreTune-native painter).
 *
 * Designed for compact "racing telemetry" style dashboards: a solid dark
 * panel, a colored accent stripe down the left edge (repurposing
 * `needle_color`, since this painter has no needle), a bold uppercase
 * label, a large monospace value, and a thin range bar along the bottom
 * showing where the value sits between min/max (with warning/critical tick
 * marks). Deliberately flat — no metallic bezel/gradient — to read as
 * "modern HUD" rather than a skeuomorphic gauge.
 */

import { tsColorToHex } from '../../dashboards/dashTypes';
import { roundRect, darkenColor } from '../drawUtils';
import { useRealtimeStore } from '../../../stores/realtimeStore';
import type { Painter } from './types';

/** Latest value of a named channel from the realtime store (case-insensitive). */
function readLatestChannelValue(channel: string): number | undefined {
  const channels = useRealtimeStore.getState().channels;
  if (channels[channel] !== undefined) return channels[channel];
  const lower = channel.toLowerCase();
  for (const key of Object.keys(channels)) {
    if (key.toLowerCase() === lower) return channels[key];
  }
  return undefined;
}

export const telemetryStatPainter: Painter = (pctx) => {
  const { ctx, width, height, value, config, getValueColor, getFontSpec } = pctx;

  // Compact (single-row label+value) only for genuinely small/short tiles like
  // the dense Telemetry Live grid. A wide *and* tall tile (e.g. a primary tuning
  // card) has room for the full layout — label on top, big value, range bar with
  // target marker — so don't force it into the cramped one-row mode.
  const compact = height < 42 || (height < width * 0.45 && height < 110);
  const cornerRadius = compact ? 2 : Math.min(6, width * 0.04, height * 0.08);
  const accentWidth = compact ? 0 : Math.max(3, width * 0.025);
  const padding = compact ? Math.max(4, width * 0.04) : Math.max(8, width * 0.06);

  // Panel background (flat, subtle vertical darken toward the bottom).
  const bgHex = tsColorToHex(config.back_color);
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, bgHex);
  bgGradient.addColorStop(1, darkenColor(bgHex, 6));
  ctx.fillStyle = bgGradient;
  roundRect(ctx, 0, 0, width, height, cornerRadius);
  ctx.fill();

  if (!compact) {
    // Accent stripe down the left edge.
    const accentHex = tsColorToHex(config.needle_color);
    ctx.save();
    roundRect(ctx, 0, 0, width, height, cornerRadius);
    ctx.clip();
    ctx.fillStyle = accentHex;
    ctx.fillRect(0, 0, accentWidth, height);
    ctx.restore();
  }

  const contentX = accentWidth + padding * (compact ? 0.4 : 0.6);
  const minDim = Math.min(width, height);
  const fontScale = 1 + (config.font_size_adjustment ?? 0) * 0.1;

  const valueColor = getValueColor();
  const valueHex = tsColorToHex(valueColor);
  const valueText = value.toFixed(config.value_digits);
  // Skip units that merely repeat the label (e.g. an RPM gauge whose INI units
  // are "RPM"), which would render redundantly as "RPM 100 RPM".
  const showUnits =
    config.units.trim().length > 0 &&
    config.units.trim().toUpperCase() !== config.title.trim().toUpperCase();

  if (compact) {
    // Dense Grafana-style: label left, value right on one row.
    const labelSize = Math.max(7, minDim * 0.22 * fontScale);
    ctx.fillStyle = tsColorToHex(config.trim_color);
    ctx.font = getFontSpec(labelSize, { bold: true });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(config.title.toUpperCase(), contentX, height / 2);

    const valueSize = Math.max(9, minDim * 0.34 * fontScale);
    if (valueHex !== tsColorToHex(config.font_color)) {
      ctx.shadowColor = valueHex;
      ctx.shadowBlur = 6;
    }
    ctx.fillStyle = valueHex;
    ctx.font = getFontSpec(valueSize, { bold: true, monospace: true });
    ctx.textAlign = 'right';
    const valueLine = showUnits ? `${valueText} ${config.units}` : valueText;
    ctx.fillText(valueLine, width - padding, height / 2);
    ctx.shadowColor = 'transparent';
    return;
  }

  // Uppercase label along the top edge, shrunk to fit the card.
  //
  // The title is not always the short one the template chose: range-sync
  // replaces it with the INI's, which can be far longer ("Air:Fuel Ratio" for
  // an AFR tile). Drawing that at a fixed size runs it off the card and into
  // the neighbouring tile, so measure the letter-spaced width and scale down
  // until it fits.
  const labelText = config.title.toUpperCase();
  const labelMaxW = width - contentX - padding * 0.5;
  let labelSize = Math.max(9, minDim * 0.13 * fontScale);
  let labelSpacing = Math.max(1, labelSize * 0.12);
  ctx.font = getFontSpec(labelSize, { bold: true });
  const labelW = letterSpacedWidth(ctx, labelText, labelSpacing);
  if (labelW > labelMaxW && labelW > 0) {
    const s = labelMaxW / labelW;
    labelSize = Math.max(7, labelSize * s);
    labelSpacing = Math.max(0.5, labelSpacing * s);
  }
  const labelY = padding * 0.5;
  ctx.fillStyle = tsColorToHex(config.trim_color);
  ctx.font = getFontSpec(labelSize, { bold: true });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  drawLetterSpaced(ctx, labelText, contentX, labelY, labelSpacing);

  // Reserve the range bar's band at the bottom (drawn further down).
  const barHeight = Math.max(3, height * 0.06);
  const barY = height - padding * 0.5 - barHeight;
  const barX = contentX;
  const barW = width - contentX - padding * 0.5;

  // Size the value to the free space BETWEEN the label and the bar, then clamp
  // to the card width. Sizing to the available box (rather than a fixed
  // fraction of the card) is what keeps large values from colliding with the
  // label or overflowing — the whole point of the "big legible number" look.
  const areaTop = labelY + labelSize + height * 0.05;
  const areaBottom = barY - height * 0.05;
  const areaH = Math.max(10, areaBottom - areaTop);
  const maxValueW = width - contentX - padding * 0.7;
  const nudge = 1 + (config.font_size_adjustment ?? 0) * 0.06;

  let valueSize = Math.min(areaH * 0.94 * nudge, height * 0.62);
  let unitsSize = valueSize * 0.36;
  const totalWidth = (vs: number, us: number): number => {
    ctx.font = getFontSpec(vs, { bold: true, monospace: true });
    let w = ctx.measureText(valueText).width;
    if (config.units) {
      ctx.font = getFontSpec(us, { bold: true });
      w += us * 0.4 + ctx.measureText(config.units).width;
    }
    return w;
  };
  const tw = totalWidth(valueSize, unitsSize);
  if (tw > maxValueW) {
    const s = maxValueW / tw;
    valueSize *= s;
    unitsSize *= s;
  }
  valueSize = Math.max(12, valueSize);
  unitsSize = Math.max(8, unitsSize);

  // Baseline that vertically centers the value within its area.
  const valueBaselineY = (areaTop + areaBottom) / 2 + valueSize * 0.34;
  const isAlert = valueHex !== tsColorToHex(config.font_color);
  if (isAlert) {
    ctx.shadowColor = valueHex;
    ctx.shadowBlur = 10;
  }
  ctx.fillStyle = valueHex;
  ctx.font = getFontSpec(valueSize, { bold: true, monospace: true });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(valueText, contentX, valueBaselineY);
  ctx.shadowColor = 'transparent';

  if (showUnits) {
    ctx.font = getFontSpec(valueSize, { bold: true, monospace: true });
    const valueWidth = ctx.measureText(valueText).width;
    ctx.fillStyle = tsColorToHex(config.trim_color);
    ctx.font = getFontSpec(unitsSize, { bold: true });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(config.units, contentX + valueWidth + unitsSize * 0.4, valueBaselineY);
  }

  // Thin range bar along the bottom, with warning/critical tick marks.
  if (barW > 4) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    roundRect(ctx, barX, barY, barW, barHeight, barHeight / 2);
    ctx.fill();

    const range = config.max - config.min;
    const pct = range !== 0 ? Math.max(0, Math.min(1, (value - config.min) / range)) : 0;
    if (pct > 0) {
      ctx.fillStyle = valueHex;
      roundRect(ctx, barX, barY, Math.max(barHeight, barW * pct), barHeight, barHeight / 2);
      ctx.fill();
    }

    const tick = (v: number | null | undefined, color: string) => {
      if (v == null || range === 0) return;
      const t = Math.max(0, Math.min(1, (v - config.min) / range));
      const tx = barX + barW * t;
      ctx.fillStyle = color;
      ctx.fillRect(tx - 0.5, barY - 2, 1, barHeight + 4);
    };
    tick(config.low_warning, tsColorToHex(config.warn_color));
    tick(config.high_warning, tsColorToHex(config.warn_color));
    tick(config.low_critical, tsColorToHex(config.critical_color));
    tick(config.high_critical, tsColorToHex(config.critical_color));

    // Live target marker from a second channel (e.g. AFR vs afrTarget): a
    // bright, tall tick so you can see at a glance how far the value sits from
    // its target — the core feedback for VE tuning.
    const targetChannel = config.extra_attrs?.lt_target_channel;
    if (targetChannel && range !== 0) {
      const tv = readLatestChannelValue(targetChannel);
      if (tv !== undefined && Number.isFinite(tv)) {
        const tt = Math.max(0, Math.min(1, (tv - config.min) / range));
        const tx = barX + barW * tt;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fillRect(tx - 1, barY - 4, 2, barHeight + 8);
      }
    }
  }
};

/** Draw text with manual letter-spacing (canvas text APIs have no native support). */
/** Width `drawLetterSpaced` will occupy, so callers can fit before drawing. */
function letterSpacedWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  spacing: number,
): number {
  if (text.length === 0) return 0;
  let w = 0;
  for (const char of text) w += ctx.measureText(char).width + spacing;
  return w - spacing;
}

function drawLetterSpaced(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
): void {
  let cursorX = x;
  for (const char of text) {
    ctx.fillText(char, cursorX, y);
    cursorX += ctx.measureText(char).width + spacing;
  }
}
