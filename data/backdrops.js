/*
 * Backdrops: pictures shown out of focus behind a game's page and its details window, each
 * drifting left and zooming in a little before it fades into the next. The files are in
 * assets/backdrops/<game page slug>/. "focus" is the part of the picture kept in view when the
 * window is narrower than the picture, as a CSS background-position (across, then down).
 * Read by the site (app.js) and the game-page builder (tools/build_pages.py), so it's plain JSON
 * after the assignment.
 */
window.RECOMPHAVEN_BACKDROPS = {
 "lost-odyssey": [
  {"file": "1-uhra.webp", "focus": "25% 40%"},
  {"file": "2-kaim.webp", "focus": "68% 35%"},
  {"file": "3-cliff.webp", "focus": "83% 40%"},
  {"file": "4-meadow.webp", "focus": "28% 30%"},
  {"file": "5-duel.webp", "focus": "22% 40%"}
 ]
};
