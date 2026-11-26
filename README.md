# Gel pseudo-chromatograms

An interactive viewer for streptavidin blots from a biotin-GPP in vitro prenylation
assay on mouse blood lysates. Every lane is read as a trace on one apparent-mass axis
(kDa, from each gel's own Precision Plus ladder), so lanes from different gels can be
laid over each other, with the gel images alongside.

Open `index.html` through a web server (GitHub Pages, or `python3 -m http.server` in
this folder); opened straight from disk the browser won't load the data.

## Using it

- **Lanes** (left): tick lanes to overlay them. Filter by defect / no defect; each
  experiment has `all` / `none` and `gel` (show its image).
- **Plot**: drag to zoom, double-click to reset. Height is a fraction of a saturated
  pixel on that image (1 = saturated; a flat top means saturated).
- **Picking a band**: by default a click on a gel image (or on a trace in the plot) picks
  the band at that size, so it's marked on every lane of the gel (✓ seen, ✗ not seen),
  on the plot and in the band table. A band the table doesn't have yet gets its own row.
  "Click picks a lane" switches the gel images back to adding and removing lanes.
- **Gel images**, two views:
  - *Whole gels*: one gel at a time; click a lane to add or remove it.
  - *Selected lanes side by side*: each selected lane cut from its gel next to that
    gel's ladder, all stretched onto one kDa scale so sizes line up across gels.
  - Hovering over the plot marks that size on the gel view.
- **Bands**: the current reading of each band. Each "Best guess" carries footnotes to the
  papers behind it, with the reference list under the table; "Show evidence" puts the
  lanes behind each claim on the plot and the side-by-side strips, lists the literature,
  and sorts every lane into seen / not seen / unclear for that band. Click a row to highlight it on the plot
  and the strips (no zoom, so the whole profile stays in view).
- **Lane details** (folded): each legend line with every recorded field for its lane.
- The address bar keeps the version, the lanes and the colouring, so a link
  reopens the same view.

## Versions

Each version is a folder under `data/` (`data.json`, `bands.json`, `img/`) and a line
in `versions.json`; the page offers them in the Version menu, newest first. They're
made by `export_site.py` beside the analysis script (`pseudochrom.py`):

```bash
../../.venv/bin/python export_site.py v2 --note "what changed"
```

People's names are removed from the notebook notes on export.

## Caveats

Apparent sizes hold to about 5-10% between gels (one ladder per gel); heights compare
best within one gel. Some images are exported figures with their contrast already set.
Band names are guesses from size: nothing here identifies a protein. Unpublished
optimisation data.
