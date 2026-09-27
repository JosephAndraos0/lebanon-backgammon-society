// Builds the UI test pages from the real index.html. Run:  node tests/ui/build.js
//   tests/ui/index.html   the real page with the Supabase library swapped for fake-supabase.js (a fake backend)
//   tests/ui/sample.html  the real page with the Supabase keys blanked (the site's "sample data" mode)
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "..");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const relink = (h) => h.replace(/src="(js|img)\//g, 'src="../../$1/').replace('href="styles.css"', 'href="../../styles.css"');

const fake = relink(source.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^>]*supabase[^>]*><\/script>/, '<script src="fake-supabase.js"></script>'));
if (fake.indexOf("fake-supabase.js") === -1) throw new Error("could not swap the Supabase script tag");
fs.writeFileSync(path.join(__dirname, "index.html"), fake);

const blank = '<script>window.LBS_CONFIG.SUPABASE_URL="";window.LBS_CONFIG.SUPABASE_ANON_KEY="";</script>';
const sample = relink(source).replace('<script src="../../js/bracket.js">', blank + '\n<script src="../../js/bracket.js">');
if (sample.indexOf(blank) === -1) throw new Error("could not insert the blank-keys script");
fs.writeFileSync(path.join(__dirname, "sample.html"), sample);
console.log("wrote tests/ui/index.html and tests/ui/sample.html");
