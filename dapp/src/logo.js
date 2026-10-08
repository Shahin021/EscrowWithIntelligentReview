/**
 * The GenLayer mark, traced from the supplied logo image.
 *
 * The three paths are the mark's own sections: the left wing, the right wing
 * and the centre diamond. Their geometry was extracted from the source image
 * by contour tracing, so the proportions are the original's. Nothing was
 * redrawn, and no segment was invented.
 *
 * The mark itself never moves. Light travels across it instead: a gradient
 * sweep rotates around the centre while each section brightens in turn,
 * clockwise, which reads as rotating illumination on a stationary object.
 *
 * Phases are driven by real application events only; see setPhase() and
 * pulse(), both called from transaction lifecycle transitions in main.js.
 */

const SECTIONS = [
  { id: "left", d: "M 183,33 L 183,152 L 122,279 L 124,283 L 179,310 L 20,372 Z" },
  { id: "right", d: "M 218,33 L 381,372 L 222,310 L 280,281 L 218,151 Z" },
  { id: "core", d: "M 200,195 L 235,264 L 235,266 L 200,283 L 166,265 Z" },
];

// Clockwise from the apex: the right wing sweeps down, through the centre,
// and the left wing climbs back up.
const CLOCKWISE = ["right", "core", "left"];

export const PHASE_IDLE = "idle";
export const PHASE_BUSY = "busy";
export const PHASE_ERROR = "error";

const pathFor = (id) => SECTIONS.find((section) => section.id === id).d;

export function createLogo(mount, { title = "GenLayer" } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

  svg.setAttribute("viewBox", "0 0 400 400");
  svg.setAttribute("class", "mark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", title);
  svg.dataset.phase = PHASE_IDLE;

  svg.innerHTML = `
    <defs>
      <linearGradient id="markSweep" x1="0" y1="0" x2="1" y2="0"
                      gradientUnits="objectBoundingBox">
        <stop offset="0%" stop-color="var(--sweep-a)" />
        <stop offset="45%" stop-color="var(--sweep-b)" />
        <stop offset="100%" stop-color="var(--sweep-c)" />
        <animateTransform attributeName="gradientTransform" type="rotate"
                          from="0 0.5 0.5" to="360 0.5 0.5"
                          dur="16s" repeatCount="indefinite" />
      </linearGradient>
      <filter id="markGlow" x="-45%" y="-45%" width="190%" height="190%">
        <feGaussianBlur stdDeviation="6" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
    <g class="mark-bed">
      ${SECTIONS.map(
        (section) =>
          `<path class="mark-base" data-section="${section.id}" d="${section.d}" />`,
      ).join("")}
    </g>
    <g class="mark-lit" filter="url(#markGlow)">
      ${CLOCKWISE.map(
        (id, index) =>
          `<path class="mark-light" data-section="${id}" style="--order:${index}" d="${pathFor(
            id,
          )}" />`,
      ).join("")}
    </g>`;

  mount.replaceChildren(svg);
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const updateMotion = () => {
    if (motionPreference.matches) svg.pauseAnimations();
    else svg.unpauseAnimations();
  };
  updateMotion();
  motionPreference.addEventListener("change", updateMotion);

  let pulseTimer = null;

  return {
    element: svg,

    /** Reflect an application state. Never called from a click handler. */
    setPhase(phase) {
      if (svg.dataset.phase !== phase) svg.dataset.phase = phase;
    },

    /**
     * One synchronized pulse across every section, reserved for a result the
     * network has actually confirmed as finalized.
     */
    pulse() {
      svg.classList.remove("is-pulsing");
      void svg.getBoundingClientRect(); // reflow, so repeats re-run
      svg.classList.add("is-pulsing");

      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => svg.classList.remove("is-pulsing"), 1500);
    },
  };
}
