// digStaircaseDown: dig a safe 3-block-tall descending staircase underground.
// Use this BEFORE mineBlock when ore is deep underground, so you can walk
// back up the same staircase afterward. Never dig a vertical shaft — always
// use a staircase so you can escape.
//
// Parameters:
//   steps      — number of staircase steps (each step goes 1 block deeper)
//   direction  — 'north' | 'south' | 'east' | 'west' (default: 'north')
//   targetY    — optional: stop early when bot reaches this Y level
//
// Examples:
//   await digStaircaseDown(bot, 15);                    // go 15 steps north
//   await digStaircaseDown(bot, 20, 'east');            // go 20 steps east
//   await digStaircaseDown(bot, 50, 'north', -30);      // dig until y ≤ -30
async function digStaircaseDown(bot, steps, direction = 'north', targetY = null) {
    // [see full implementation in control_primitives/digStaircaseDown.js]
}
