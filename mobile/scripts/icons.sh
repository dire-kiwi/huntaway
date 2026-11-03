#!/usr/bin/env bash
# Renders the app's icons in mobile/assets from the board's icon (app/public/icon.svg): the dog on its violet gradient.
# Run it again after changing that icon, and copy the change into the paths below. Needs rsvg-convert (librsvg).
#
#   icon.png                     1024², iOS (and the fallback): full bleed and opaque, since iOS rounds the corners itself
#   android-icon-background.png  the adaptive icon's back layer, the gradient
#   android-icon-foreground.png  its front layer, the dog: 108dp, of which the launcher shows the middle 72dp (the
#                                board's 512 units), masked to a circle or squircle, so the body runs on past the edges
#   android-icon-monochrome.png  Android 13's themed icon: one colour, the dark fur, with the tan and eyes cut out
#   splash-icon.png, favicon.png the board's rounded icon
set -euo pipefail
cd "$(dirname "$0")/../assets"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

gradient='<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b8cf9"/><stop offset="1" stop-color="#4f46e5"/></linearGradient>'

# The dog, in app/public/icon.svg's 512 units, with its body and chest carried on to y=640 for the adaptive icon. $1 is
# the dark fur's colour, $2 the tan's, $3 the eyes', $4 their highlights', $5 the nose's and mouth's, $6 the tongue's.
dog() {
  cat <<EOF
<path d="M176 300 C 160 390 120 460 84 512 L -5 640 H 517 L 428 512 C 392 460 352 390 336 300 Z" fill="$1"/>
<path d="M256 436 C 292 444 320 480 328 512 L 360 640 H 152 L 184 512 C 192 480 220 444 256 436 Z" fill="$2"/>
<path d="M256 108 C 316 108 360 136 366 192 C 372 244 350 290 334 320 C 324 356 306 392 284 404 C 268 412 244 412 228 404 C 206 392 188 356 178 320 C 162 290 140 244 146 192 C 152 136 196 108 256 108 Z" fill="$1"/>
<path d="M196 288 C 212 268 236 268 246 286 L 246 326 C 246 348 254 352 256 352 C 258 352 266 348 266 326 L 266 286 C 276 268 300 268 316 288 C 326 300 332 312 332 324 C 322 358 306 392 284 404 C 268 412 244 412 228 404 C 206 392 190 358 180 324 C 180 312 186 300 196 288 Z" fill="$2"/>
<ellipse cx="212" cy="206" rx="18" ry="11" transform="rotate(-12 212 206)" fill="$2"/>
<ellipse cx="300" cy="206" rx="18" ry="11" transform="rotate(12 300 206)" fill="$2"/>
<circle cx="216" cy="242" r="15" fill="$3"/><circle cx="296" cy="242" r="15" fill="$3"/>
<circle cx="221" cy="236" r="5" fill="$4"/><circle cx="301" cy="236" r="5" fill="$4"/>
<path d="M222 336 C 222 318 290 318 290 336 C 290 356 268 368 256 368 C 244 368 222 356 222 336 Z" fill="$5"/>
<path d="M238 383 C 238 410 274 410 274 383 Z" fill="$6"/>
<path d="M256 368 V 380 M 256 380 C 246 392 228 394 216 384 M 256 380 C 266 392 284 394 296 384" stroke="$5" stroke-width="7" stroke-linecap="round" fill="none"/>
<path d="M190 122 C 150 120 112 140 106 180 C 102 214 118 246 140 262 C 152 270 164 262 166 246 C 170 214 176 178 214 140 Z" fill="#111116"/>
<path d="M322 122 C 362 120 400 140 406 180 C 410 214 394 246 372 262 C 360 270 348 262 346 246 C 342 214 336 178 298 140 Z" fill="#111116"/>
EOF
}
colours=("#1d1d26" "#c9823c" "#3b2312" "#fff" "#0e0e12" "#e8737f")

svg() { echo "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"$1\"><defs>$gradient<clipPath id=\"c\"><rect x=\"0\" y=\"0\" width=\"512\" height=\"512\" rx=\"$2\"/></clipPath></defs>$3</svg>"; }

# iOS: square and opaque.
svg "0 0 512 512" 0 "<rect width=\"512\" height=\"512\" fill=\"url(#bg)\"/><g clip-path=\"url(#c)\">$(dog "${colours[@]}")</g>" > "$out/icon.svg"
# The board's own, rounded.
svg "0 0 512 512" 112 "<rect width=\"512\" height=\"512\" rx=\"112\" fill=\"url(#bg)\"/><g clip-path=\"url(#c)\">$(dog "${colours[@]}")</g>" > "$out/rounded.svg"
# Adaptive layers: 768 units (108dp) around the board's 512 (72dp).
svg "-128 -128 768 768" 0 "<rect x=\"-128\" y=\"-128\" width=\"768\" height=\"768\" fill=\"url(#bg)\"/>" > "$out/background.svg"
svg "-128 -128 768 768" 0 "$(dog "${colours[@]}")" > "$out/foreground.svg"
# Monochrome: white where the fur is (ears, head, body, nose and mouth), nothing where the tan, eyes and tongue are, and
# a line between the ears and the head.
svg "-128 -128 768 768" 0 "<mask id=\"m\" maskUnits=\"userSpaceOnUse\" x=\"-128\" y=\"-128\" width=\"768\" height=\"768\">$(dog "#fff" "#000" "#000" "#000" "#fff" "#000" | sed 's/fill="#111116"/fill="#fff" stroke="#000" stroke-width="12"/')</mask><rect x=\"-128\" y=\"-128\" width=\"768\" height=\"768\" fill=\"#fff\" mask=\"url(#m)\"/>" > "$out/monochrome.svg"

render() { rsvg-convert -w "$2" -h "$2" "$out/$1.svg" -o "$3"; }
render icon 1024 icon.png
render background 1024 android-icon-background.png
render foreground 1024 android-icon-foreground.png
render monochrome 1024 android-icon-monochrome.png
render rounded 1024 splash-icon.png
render rounded 48 favicon.png
# iOS refuses an icon with an alpha channel.
magick icon.png -background "#4f46e5" -alpha remove -alpha off icon.png
ls -l icon.png android-icon-*.png splash-icon.png favicon.png
