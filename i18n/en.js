/* English UI text - the only file in the project with user-facing wording.
 *
 * Shipped as JS rather than .json for the same reason data/mapdata.js is:
 * index.html has to work when it is opened straight off the disk, and no
 * browser will fetch a file:// URL. Everything after the assignment is
 * plain JSON, so it lifts straight into en.json if this ever gets served
 * over HTTP. To add a language, copy this file and swap the script tag.
 *
 * {token} is filled in at run time. Continent and country names are not
 * here: they come from the map data, built by build/build_map.py.
 */
window.STRINGS = {
  "lang": "en",
  "title": "Wine Guesser",
  "headline": "Find the wine region",

  "splash": {
    "pick": "Find the Wine",
    "pickLine": "{n} wine regions. Pin each one on the map - the closer, the more points.",
    "daily": "Daily",
    "dailyLine": "{date}",
    "practice": "Practice",
    "practiceLine": "New regions every game",
    "normal": "Normal",
    "normalLine": "Pin the region - the closer, the more points",
    "countryOnly": "Country-Only",
    "countryOnlyLine": "Just pick the country",
    "count": "{n}"
  },

  "mode": {
    "daily": "Daily · {date}",
    "practice": "Practice",
    "practiceCountry": "Practice · Country-Only"
  },

  "header": {
    "reset": "Reset"
  },

  "map": {
    "label": "World map. Click to drop a pin.",
    "zoomIn": "Zoom in",
    "zoomOut": "Zoom out",
    "zoomFit": "Whole world",
    "zoomLevel": "{zoom}×"
  },

  "panel": {
    "continents": "Continents",
    "note": "Click a continent to fly there. Scroll or pinch to zoom, drag to pan."
  },

  "round": {
    "count": "Region {n} of {total}",
    "prompt": "Click the map where you think it is.",
    "ready": "Click again to move your pin, or lock it in.",
    "promptCountry": "Click the country you think it is in.",
    "readyCountry": "Click another country to change, or lock it in.",
    "notCountry": "That is not a country - click on land.",
    "right": "Right country · +{points}",
    "wrong": "It is in {country} · +{points}",
    "offMap": "That is off the edge of the world.",
    "away": "{km} km away",
    "result": "{km} km away · +{points}",
    "lock": "Lock in",
    "next": "Next region",
    "results": "See results"
  },

  "place": {
    "where": "{division}, {country}",
    "grapes": "Known for {grapes}",
    "grapeJoin": ", ",
    "grapeAka": "{grape} ({aka})"
  },

  "results": {
    "title": "Final score",
    "line": "{mode}",
    "outOf": "out of {max}",
    "km": "{km} km",
    "right": "Right country",
    "wrong": "Wrong country",
    "points": "{points}",
    "look": "Look at the map",
    "again": "Play again",
    "share": "Share",
    "copied": "Copied!",
    "copyFailed": "Could not copy"
  },
  "share": {
    "head": "Wine Guesser · {date}",
    "score": "{total} / {max}",
    "row": "{n}. {mark} {km} km"
  }
};
