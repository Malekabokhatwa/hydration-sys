import { compose, pixels, HEIGHT, WIDTH, type PetState } from "../core/sprite";
import { svg } from "./dom";

const DESCRIPTIONS: Record<PetState, string> = {
  idle: "is bobbing calmly",
  happy: "is smiling with closed happy eyes",
  thirsty: "is glancing up, a little thirsty",
  hungry: "looks sad and moves slowly",
  veryHungry: "is slumped in the corner, flickering",
  recovering: "is perking back up",
  goal: "is beaming, fully topped up",
  sleeping: "is asleep with closed eyes",
};

export function describePet(name: string, state: PetState, fill: number): string {
  return `${name} ${DESCRIPTIONS[state]}. water level ${Math.round(Math.min(fill, 1) * 100)} percent.`;
}

/** Renders Byte as crisp SVG pixels and keeps it animated (blink) cheaply. */
export class PetView {
  readonly el: HTMLElement;
  private art: SVGElement;
  private state: PetState = "idle";
  private fill = 0;
  private blinkTimer = 0;
  private motion = true;

  constructor() {
    this.art = svg("svg", { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, "shape-rendering": "crispEdges", "aria-hidden": "true" });
    this.art.classList.add("pet-art");
    const fx = document.createElement("div");
    fx.className = "pet-fx";
    fx.setAttribute("aria-hidden", "true");
    this.el = document.createElement("div");
    this.el.className = "pet";
    this.el.setAttribute("role", "img");
    this.el.append(this.art, fx);
  }

  update(name: string, state: PetState, fill: number, motion: boolean) {
    const changed = state !== this.state || Math.abs(fill - this.fill) > 0.001 || !this.art.firstChild;
    this.state = state;
    this.fill = fill;
    this.el.dataset.state = state;
    this.el.setAttribute("aria-label", describePet(name, state, fill));
    if (changed) this.draw(false);
    if (motion !== this.motion || !this.blinkTimer) {
      this.motion = motion;
      this.scheduleBlink();
    }
  }

  /** Short feeding animation after a drink. */
  feed() {
    if (!this.motion) return;
    this.el.classList.remove("feeding");
    void this.el.offsetWidth;
    this.el.classList.add("feeding");
    window.setTimeout(() => this.el.classList.remove("feeding"), 900);
  }

  private draw(blink: boolean) {
    const frag = document.createDocumentFragment();
    for (const p of pixels(compose(this.state, this.fill, blink))) {
      const r = svg("rect", { x: p.x, y: p.y, width: 1.02, height: 1.02 });
      r.setAttribute("class", `px-${p.key}`);
      frag.append(r);
    }
    this.art.replaceChildren(frag);
  }

  private scheduleBlink() {
    window.clearTimeout(this.blinkTimer);
    if (!this.motion) {
      this.blinkTimer = 0;
      return;
    }
    const slow = this.state === "hungry" || this.state === "veryHungry";
    this.blinkTimer = window.setTimeout(() => {
      if (document.visibilityState === "visible") {
        this.draw(true);
        window.setTimeout(() => this.draw(false), slow ? 260 : 140);
      }
      this.scheduleBlink();
    }, (slow ? 5200 : 3200) + Math.random() * 2600);
  }
}
