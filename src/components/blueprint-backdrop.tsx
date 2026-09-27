import './blueprint-backdrop.css';

// Decorative chalk-on-blueprint drawing behind the authentication card.
// Pure SVG: no images, no layout influence, hidden from assistive technology.

type Point = readonly [number, number];

const polar = (radius: number, degrees: number): Point => {
  const radians = (degrees * Math.PI) / 180;
  return [+(radius * Math.cos(radians)).toFixed(1), +(radius * Math.sin(radians)).toFixed(1)];
};

const segment = ([x1, y1]: Point, [x2, y2]: Point) => `M${x1} ${y1}L${x2} ${y2}`;

const arc = (radius: number, from: number, to: number) => {
  const [x1, y1] = polar(radius, from);
  const [x2, y2] = polar(radius, to);
  return `M${x1} ${y1}A${radius} ${radius} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
};

const radial = (inner: number, outer: number, degrees: number) => segment(polar(inner, degrees), polar(outer, degrees));

const SPOKES = [48, 63, 71, 74, 97, 121, 134];
const TOP_TICKS = [-142, -118, -93, -66, -38];
const SCALE_TICKS = Array.from({ length: 16 }, (_, index) => -90 + index * 6);

function Rings() {
  return (
    <svg className="bp-layer bp-rings" viewBox="-700 -700 1400 1400" aria-hidden="true" focusable="false">
      <g className="bp-chalk">
        <path className="bp-draw" d={arc(440, -164, -16)} />
        <path className="bp-draw bp-draw-late" d={arc(560, 18, 162)} />
        <path className="bp-faint" d={arc(318, -150, -30)} strokeDasharray="2 14" />
        <path className="bp-faint" d={arc(640, 196, 232)} />
        {TOP_TICKS.map(angle => <path key={angle} d={radial(424, 458, angle)} />)}
        {SPOKES.map(angle => <path key={angle} d={radial(548, angle === 74 ? 690 : 705, angle)} />)}
        <path d={segment([-270, 470], [-218, 512])} />
        <path d={segment([128, 556], [178, 520])} />
        <path d={segment([-12, -452], [12, -428])} />
        <path d={segment([-12, -428], [12, -452])} />
        <text className="bp-note" x="-236" y="-402" transform="rotate(-28 -236 -402)">R 440</text>
        <text className="bp-note" x="268" y="600" transform="rotate(-18 268 600)">∠ 36°</text>
      </g>
    </svg>
  );
}

function Hatching() {
  return (
    <svg className="bp-layer bp-hatch" viewBox="0 0 520 360" aria-hidden="true" focusable="false">
      <g className="bp-chalk">
        <path d="M-20 362L505-6" />
        <path d="M-20 300L392 12" />
        <path d="M-20 252L330 7" />
        <path d="M-12 206L252 21" />
        <path d="M58 262L282 105" />
        <path d="M28 332L300 141" />
        <path d="M176 58L230 134" />
        <path d="M212 42L266 118" />
        <path d="M118 150L150 194" />
        <path className="bp-faint" d="M410 40L426 56M426 40L410 56" />
      </g>
    </svg>
  );
}

function CornerSquare() {
  return (
    <svg className="bp-layer bp-corner" viewBox="0 0 460 400" aria-hidden="true" focusable="false">
      <g className="bp-chalk">
        <path d="M232-12L384 152L480 66" />
        <path d="M52-12L474 424" />
        <path d="M262 302L330 244" />
        <path d="M344 158L360 174M360 158L344 174" />
        <path className="bp-faint" d="M372 136L392 120L408 138" />
      </g>
    </svg>
  );
}

function Crystal() {
  const top: Point = [180, 44];
  const left: Point = [70, 192];
  const right: Point = [292, 170];
  const front: Point = [204, 218];
  const back: Point = [158, 150];
  const bottom: Point = [178, 344];
  return (
    <svg className="bp-layer bp-crystal" viewBox="0 0 360 410" aria-hidden="true" focusable="false">
      <g className="bp-chalk">
        {[[top, left], [top, right], [top, front], [left, front], [front, right], [bottom, left], [bottom, front], [bottom, right]]
          .map(([from, to]) => <path key={`${from}-${to}`} d={segment(from, to)} />)}
        <g className="bp-faint" strokeDasharray="7 9">
          {[[top, back], [back, right], [back, left], [bottom, back]].map(([from, to]) => <path key={`${from}-${to}`} d={segment(from, to)} />)}
          <path d="M180 8L178 384" />
        </g>
        <path d="M330 44L330 344M318 44L342 44M318 344L342 344" />
        <text className="bp-note" x="18" y="398">北洋 · 1895</text>
      </g>
    </svg>
  );
}

function Protractor() {
  return (
    <svg className="bp-layer bp-scale" viewBox="0 0 380 300" aria-hidden="true" focusable="false">
      <g className="bp-chalk" transform="translate(28 300)">
        <path d={arc(236, -90, 0)} />
        {SCALE_TICKS.map(angle => <path key={angle} d={radial(angle % 30 === 0 ? 206 : 222, 236, angle)} />)}
        <path className="bp-faint" d={segment([0, 0], polar(300, -36))} />
      </g>
    </svg>
  );
}

export function BlueprintBackdrop() {
  return (
    <div className="bp-backdrop" aria-hidden="true">
      <svg className="bp-defs" width="0" height="0" focusable="false">
        <filter id="bp-chalk-filter" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="1.3" numOctaves="2" seed="3" result="jitter" />
          <feDisplacementMap in="SourceGraphic" in2="jitter" scale="3.2" xChannelSelector="R" yChannelSelector="G" result="rough" />
          <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="1" seed="11" result="grain" />
          <feColorMatrix in="grain" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -2.4 0 0 0 1.95" result="breaks" />
          <feComposite in="rough" in2="breaks" operator="in" />
        </filter>
      </svg>
      <Rings />
      <Hatching />
      <CornerSquare />
      <Crystal />
      <Protractor />
    </div>
  );
}
