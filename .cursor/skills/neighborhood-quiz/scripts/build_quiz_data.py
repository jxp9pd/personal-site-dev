#!/usr/bin/env python3
"""Build neighborhood-quiz data from raw boundary GeoJSON.

Two subcommands, both driven by one config.json (schema in reference.md):

  mockup  config.json out.json   -> {"options": {...}} for review in mockup.html
  final   config.json out.json   -> {"geo": FeatureCollection} in the quiz format

`final` and the mockup's "merged" option dissolve merged neighborhoods by
unioning the RAW (full-precision) geometries with shapely, then simplifying
once. Simplifying per-feature first breaks shared borders and leaves visible
internal seams -- always union raw, then simplify.

shapely is required. On externally-managed Python:
  python3 -m venv venv && venv/bin/pip install shapely
  venv/bin/python build_quiz_data.py final config.json out.json
"""
import json, math, sys, os

def _walk(coords, fn):
    if isinstance(coords[0], (int, float)):
        fn(coords)
    else:
        for c in coords:
            _walk(c, fn)

def dp(points, tol):
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]; bx, by = points[b]
        dmax, idx = 0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            if ax == bx and ay == by:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / math.hypot(by - ay, bx - ax)
            if d > dmax:
                dmax, idx = d, i
        if dmax > tol and idx != -1:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for i, p in enumerate(points) if keep[i]]

def simplify_geom(geom, tol, prec):
    def ring(r):
        return [[round(p[0], prec), round(p[1], prec)] for p in dp(r, tol)]
    t, c = geom['type'], geom['coordinates']
    if t == 'Polygon':
        return {'type': t, 'coordinates': [ring(r) for r in c]}
    if t == 'MultiPolygon':
        return {'type': t, 'coordinates': [[ring(r) for r in poly] for poly in c]}
    raise ValueError('unsupported geometry: ' + t)

def centroid(geom, prec):
    def ring_c(r):
        A = cx = cy = 0.0
        for i in range(len(r) - 1):
            x0, y0 = r[i]; x1, y1 = r[i + 1]
            cr = x0 * y1 - x1 * y0
            A += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr
        if A == 0:
            xs = [p[0] for p in r]; ys = [p[1] for p in r]
            return (sum(xs) / len(xs), sum(ys) / len(ys), 0)
        A *= 0.5
        return (cx / (6 * A), cy / (6 * A), abs(A))
    t, c = geom['type'], geom['coordinates']
    rings = [poly[0] for poly in c] if t == 'MultiPolygon' else [c[0]]
    best = max((ring_c(r) for r in rings), key=lambda z: z[2])
    return [round(best[0], prec), round(best[1], prec)]

def clat(geom):
    ys = []
    _walk(geom['coordinates'], lambda p: ys.append(p[1]))
    return (min(ys) + max(ys)) / 2

def clon(geom):
    xs = []
    _walk(geom['coordinates'], lambda p: xs.append(p[0]))
    return (min(xs) + max(xs)) / 2

def load_source(src, cfg_dir):
    d = json.load(open(os.path.join(cfg_dir, src['file'])))
    feats = d['features']
    cf = src.get('city_filter')
    if cf:
        feats = [f for f in feats if f['properties'].get(cf['key']) == cf['value']]
    out = []
    for f in feats:
        name = f['properties'].get(src['name_key'])
        if name:
            out.append({'name': name, 'geom': f['geometry']})
    return out

def in_cut(geom, cut):
    if not cut:
        return True
    la, lo = clat(geom), clon(geom)
    return (cut.get('min_lat', -90) <= la <= cut.get('max_lat', 90) and
            cut.get('min_lon', -180) <= lo <= cut.get('max_lon', 180))

def to_multipolygon(geom):
    return geom if geom['type'] == 'MultiPolygon' else {'type': 'MultiPolygon', 'coordinates': [geom['coordinates']]}

def dissolve_merged(base_feats, merges, cut, tol, prec):
    """Union raw geometries per merge group, then simplify. Requires shapely."""
    from shapely.geometry import shape, mapping
    from shapely.ops import unary_union
    alias = {src: canon for canon, srcs in merges.items() for src in srcs}
    groups, order = {}, []
    for f in base_feats:
        if not in_cut(f['geom'], cut):
            continue
        canon = alias.get(f['name'], f['name'])
        if canon not in groups:
            groups[canon] = []; order.append(canon)
        groups[canon].append(shape(f['geom']).buffer(0))
    def round_geom(g):
        def r(c):
            if isinstance(c[0], (int, float)):
                return [round(c[0], prec), round(c[1], prec)]
            return [r(x) for x in c]
        return {'type': g['type'], 'coordinates': r(g['coordinates'])}
    feats = []
    for canon in order:
        merged = unary_union(groups[canon]).simplify(tol, preserve_topology=True)
        geom = to_multipolygon(round_geom(mapping(merged)))
        feats.append({'type': 'Feature',
                      'properties': {'name': canon, 'c': centroid(geom, prec)},
                      'geometry': geom})
    return feats

def cmd_mockup(cfg, cfg_dir, out):
    tol, prec = cfg.get('simplify_tol', 0.00035), cfg.get('precision', 5)
    options = {}
    for key, src in cfg['sources'].items():
        feats = load_source(src, cfg_dir)
        gj = [{'type': 'Feature',
               'properties': {'name': f['name'], 'c': centroid(simplify_geom(f['geom'], tol, prec), prec)},
               'geometry': simplify_geom(f['geom'], tol, prec)} for f in feats]
        options[key] = {'label': src.get('label', key), 'source': src.get('file'),
                        'geo': {'type': 'FeatureCollection', 'features': gj}, 'count': len(gj)}
    base = cfg.get('base_source')
    cut = cfg.get('geo_cut')
    if base and cut:
        bf = load_source(cfg['sources'][base], cfg_dir)
        cur = [f for f in bf if in_cut(f['geom'], cut)]
        gj = [{'type': 'Feature',
               'properties': {'name': f['name'], 'c': centroid(simplify_geom(f['geom'], tol, prec), prec)},
               'geometry': simplify_geom(f['geom'], tol, prec)} for f in cur]
        options['curated'] = {'label': 'Curated (geo cut)', 'source': 'base + geo_cut',
                              'geo': {'type': 'FeatureCollection', 'features': gj}, 'count': len(gj)}
    if base and cfg.get('merges'):
        feats = dissolve_merged(load_source(cfg['sources'][base], cfg_dir), cfg['merges'], cut, tol, prec)
        options['merged'] = {'label': 'Curated (merged)', 'source': 'base + geo_cut + merges (dissolved)',
                             'geo': {'type': 'FeatureCollection', 'features': feats}, 'count': len(feats)}
    json.dump({'options': options}, open(out, 'w'), separators=(',', ':'))
    for k, v in options.items():
        print(f"  {k}: {v['count']}")

def cmd_final(cfg, cfg_dir, out):
    tol, prec = cfg.get('simplify_tol', 0.00035), cfg.get('precision', 5)
    base = cfg['base_source']
    feats = dissolve_merged(load_source(cfg['sources'][base], cfg_dir),
                            cfg.get('merges', {}), cfg.get('geo_cut'), tol, prec)
    feats.sort(key=lambda f: f['properties']['name'])
    json.dump({'geo': {'type': 'FeatureCollection', 'features': feats}}, open(out, 'w'), separators=(',', ':'))
    xs, ys = [], []
    for f in feats:
        _walk(f['geometry']['coordinates'], lambda p: (xs.append(p[0]), ys.append(p[1])))
    print(f"wrote {out}: {len(feats)} neighborhoods, {round(os.path.getsize(out)/1024)} KB")
    print(f"suggested center [lat,lon]: [{round((min(ys)+max(ys))/2,4)},{round((min(xs)+max(xs))/2,4)}]")

def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ('mockup', 'final'):
        print(__doc__); sys.exit(1)
    mode, cfg_path, out = sys.argv[1:4]
    cfg = json.load(open(cfg_path))
    cfg_dir = os.path.dirname(os.path.abspath(cfg_path))
    (cmd_mockup if mode == 'mockup' else cmd_final)(cfg, cfg_dir, out)

if __name__ == '__main__':
    main()
