import { api, errorText } from "../api";
import { addDays, prettyDay, shortDay } from "../core/dates";
import { buildDays, dayDiff, gitLog, gitLogText, heatmap, LEVEL_GLYPH, LEVEL_LABEL, streaks, tags, weekly, type Day } from "../core/history";
import { formatAmount } from "../core/units";
import { clear, h, panel } from "./dom";
import type { Ctx } from "./today";

type Mode = "log" | "oneline" | "graph" | "tags";
const WEEKS = 20;

export class HistoryView {
  readonly el: HTMLElement;
  private mode: Mode = "log";
  private modeBar = h("div", { class: "seg", role: "radiogroup", "aria-label": "history view" });
  private body = h("div", { class: "hist-body" });
  private detail = h("div", { class: "detail", "aria-live": "polite" });
  private summary = h("div", { class: "weekly" });
  private selected: string | null = null;
  private days: Day[] = [];

  constructor(private ctx: Ctx) {
    const modes: [Mode, string][] = [["log", "git log"], ["oneline", "--oneline"], ["graph", "graph"], ["tags", "tags"]];
    for (const [m, label] of modes) {
      this.modeBar.append(
        h("button", { class: "seg-btn", type: "button", role: "radio", "data-mode": m, onclick: () => this.setMode(m) }, label),
      );
    }
    this.modeBar.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = modes.findIndex(([m]) => m === this.mode);
      const next = modes[(i + (e.key === "ArrowRight" ? 1 : modes.length - 1)) % modes.length][0];
      this.setMode(next);
      (this.modeBar.querySelector(`[data-mode="${next}"]`) as HTMLElement)?.focus();
      e.preventDefault();
    });
    const exportBtn = h("button", { class: "btn ghost small", type: "button", onclick: () => void this.exportLog() }, "export log.txt");
    this.el = h(
      "div",
      { class: "view history", id: "view-history", role: "tabpanel", "aria-labelledby": "tab-history", hidden: true },
      panel("week.summary", "week-panel", this.summary),
      panel("git log", "log-view", h("div", { class: "hist-tools" }, this.modeBar, exportBtn), this.body),
      panel("diff", "diff-panel", this.detail),
    );
  }

  private setMode(m: Mode) {
    this.mode = m;
    this.render();
  }

  render() {
    const s = this.ctx.snap();
    const u = s.settings.unit;
    this.days = buildDays(s.entries, s.dayGoals, s.settings.goalMl, s.today, WEEKS * 7);
    this.modeBar.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b) => {
      const on = b.dataset.mode === this.mode;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });

    const w = weekly(this.days);
    const st = streaks(this.days);
    clear(
      this.summary,
      stat("7d total", formatAmount(w.total, u)),
      stat("avg/day", formatAmount(w.average, u)),
      stat("goal days", `${w.goalDays}/7`),
      stat("streak", `${st.current}d`, `best ${st.best}d`),
    );

    clear(this.body);
    if (this.mode === "graph") this.body.append(this.graph());
    else if (this.mode === "tags") this.body.append(this.tagList());
    else this.body.append(this.log(this.mode === "oneline"));

    const sel = this.days.find((d) => d.date === (this.selected ?? s.today)) ?? this.days[this.days.length - 1];
    clear(this.detail, ...dayDiff(sel, addDays(sel.date, -1), u).map((l) => h("div", { class: `diff-line ${l.startsWith("+") ? "add" : l.startsWith("@@") ? "hunk" : l.startsWith("=") ? "sum" : "meta"}` }, l)));
  }

  private select(date: string, reveal = false) {
    this.selected = date;
    const focusedCell = (document.activeElement as HTMLElement | null)?.classList.contains("cell");
    this.render();
    if (focusedCell) (this.body.querySelector(`.cell[tabindex="0"]`) as HTMLElement | null)?.focus();
    if (reveal) this.detail.scrollIntoView({ block: "nearest" });
  }

  private log(oneline: boolean): HTMLElement {
    const s = this.ctx.snap();
    const lines = gitLog(this.days.filter((d) => d.entries.length || d.date >= addDays(s.today, -13)), s.settings.unit, { oneline });
    const list = h("div", { class: `gitlog ${oneline ? "oneline" : ""}`, role: "list" });
    for (const l of lines) {
      if (l.kind === "header") {
        list.append(
          h("div", { role: "listitem" }, h(
            "button",
            { class: `gl-head ${l.met ? "met" : ""}`, type: "button", "aria-label": `${l.text}. show diff`, onclick: () => this.select(l.date!, true) },
            h("span", { class: "gl-date" }, `commit-date ${l.text}`),
            ...(l.tags ?? []).map((t) => h("span", { class: "tag" }, `tag: ${t}`)),
          )),
        );
      } else if (l.kind === "commit") {
        list.append(
          h(
            "div",
            { class: "gl-commit", role: "listitem" },
            h("span", { class: "graph", "aria-hidden": "true" }, oneline ? "" : "* "),
            h("span", { class: "hash" }, l.hash!),
            oneline ? null : h("span", { class: "time" }, l.time!),
            h("span", { class: "msg" }, l.text),
            l.head ? h("span", { class: "head" }, "(HEAD -> main)") : null,
          ),
        );
      } else {
        list.append(h("div", { class: `gl-${l.kind}`, role: "listitem", "aria-hidden": l.kind === "spacer" ? "true" : null }, h("span", { class: "graph" }, "| "), l.text));
      }
    }
    if (!lines.some((l) => l.kind === "commit")) list.append(h("div", { class: "gl-empty" }, "no commits yet. log a drink to start history."));
    return list;
  }

  private graph(): HTMLElement {
    const s = this.ctx.snap();
    const u = s.settings.unit;
    const cols = heatmap(this.days, s.today, WEEKS);
    const grid = h("div", { class: "heat", role: "grid", "aria-label": `contribution graph, last ${WEEKS} weeks. arrow keys move between days, enter shows the diff` });
    const cells: HTMLButtonElement[][] = [];
    const labels = ["s", "m", "t", "w", "t", "f", "s"];
    grid.append(h("div", { class: "heat-days", "aria-hidden": "true" }, ...labels.map((l, i) => h("span", {}, i % 2 ? l : ""))));
    const focusDate = this.selected ?? s.today;
    cols.forEach((col, ci) => {
      const c = h("div", { class: "heat-col", role: "row" });
      cells[ci] = [];
      col.forEach((cell, ri) => {
        const label = cell.future ? `${prettyDay(cell.date)}: upcoming` : `${prettyDay(cell.date)}: ${formatAmount(cell.total, u)} of ${formatAmount(cell.goal || s.settings.goalMl, u)}, ${LEVEL_LABEL[cell.level]}`;
        const b = h(
          "button",
          {
            class: `cell l${cell.level} ${cell.future ? "future" : ""} ${cell.date === s.today ? "today" : ""}`,
            type: "button",
            role: "gridcell",
            title: label,
            "aria-label": label,
            "aria-selected": String(cell.date === focusDate),
            tabindex: cell.date === focusDate ? 0 : -1,
            disabled: cell.future,
            onclick: () => this.select(cell.date, true),
            onkeydown: (e: Event) => this.heatKey(e as KeyboardEvent, cells, ci, ri),
          },
          LEVEL_GLYPH[cell.level],
        );
        cells[ci][ri] = b;
        c.append(b);
      });
      grid.append(c);
    });
    const legend = h(
      "div",
      { class: "legend" },
      h("span", { class: "dim" }, "less"),
      ...LEVEL_GLYPH.map((g, i) => h("span", { class: `cell l${i}`, title: LEVEL_LABEL[i], "aria-label": LEVEL_LABEL[i] }, g)),
      h("span", { class: "dim" }, "goal"),
    );
    const metDays = this.days.slice(-WEEKS * 7).filter((d) => d.met).length;
    const sr = h("p", { class: "sr-only" }, `${metDays} of the last ${WEEKS * 7} days met their goal. select a day for details.`);
    const wrap = h("div", { class: "heat-wrap" }, grid, legend, sr);
    // Newest weeks are on the right; start scrolled there on narrow windows.
    requestAnimationFrame(() => (wrap.scrollLeft = wrap.scrollWidth));
    return wrap;
  }

  private heatKey(e: KeyboardEvent, cells: HTMLButtonElement[][], ci: number, ri: number) {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    let [c, r] = [ci + m[0], ri + m[1]];
    if (r < 0) [c, r] = [c - 1, 6];
    if (r > 6) [c, r] = [c + 1, 0];
    const target = cells[c]?.[r];
    // Arrows only move focus (a roving tabindex); Enter/Space selects.
    if (target && !target.disabled) {
      cells.flat().forEach((b) => (b.tabIndex = -1));
      target.tabIndex = 0;
      target.focus();
    }
  }

  private tagList(): HTMLElement {
    const t = tags(this.days);
    const st = streaks(this.days);
    const list = h(
      "ul",
      { class: "tags" },
      h("li", { class: "branch" }, h("span", { class: "tag main" }, "* main"), ` current streak ${st.current} day${st.current === 1 ? "" : "s"}`),
    );
    if (t.length === 0) list.append(h("li", { class: "dim" }, "no tags yet. the first goal day gets v1.0."));
    for (const tag of t) {
      list.append(
        h("li", {}, h("button", { class: "linkish", type: "button", onclick: () => this.select(tag.date, true) }, h("span", { class: "tag" }, tag.name), ` ${shortDay(tag.date)} · ${tag.note}`)),
      );
    }
    return list;
  }

  private async exportLog() {
    const s = this.ctx.snap();
    const all = buildDays(s.entries, s.dayGoals, s.settings.goalMl, s.today);
    try {
      const path = await api.exportText(gitLogText(all, s.settings.unit, s.settings.petName));
      if (path) this.ctx.say(`log written to ${path}`, "ok");
    } catch (e) {
      this.ctx.say(`export failed: ${errorText(e)}`, "err");
    }
  }
}

function stat(label: string, value: string, sub?: string): HTMLElement {
  return h("div", { class: "stat" }, h("span", { class: "stat-label" }, label), h("span", { class: "stat-value" }, value), sub ? h("span", { class: "stat-sub" }, sub) : null);
}
