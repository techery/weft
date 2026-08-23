/**
 * Final report assembly. No agent, no await: the same sections always produce the
 * same markdown, byte for byte, so a report can be diffed between runs and a
 * workflow's last step never spends a token on formatting.
 */
import type { Ctx } from "@weft/sdk";
import { z } from "@weft/sdk";

export interface ReportSection {
  heading: string;
  body: string;
}

export const ReportSectionSchema = z.object({
  heading: z.string(),
  body: z.string(),
});

export const FinalReportOptionsSchema = z.object({
  title: z.string(),
  sections: z.array(ReportSectionSchema),
});

export interface FinalReportOptions {
  title: string;
  sections: ReportSection[];
}

/**
 * Assemble sections into markdown deterministically.
 *
 * ```ts
 * return { report: finalReport(ctx, { title: "Audit", sections: [{ heading: "Findings", body }] }) };
 * ```
 */
export function finalReport(ctx: Ctx, opts: FinalReportOptions): string {
  const blocks: string[] = [`# ${opts.title.trim()}`];
  for (const section of opts.sections) {
    const heading = section.heading.trim();
    const body = section.body.trim();
    blocks.push(`## ${heading}`);
    if (body.length > 0) blocks.push(body);
  }
  ctx.log(`finalReport: "${opts.title.trim()}" with ${opts.sections.length} section(s)`);
  return `${blocks.join("\n\n")}\n`;
}
