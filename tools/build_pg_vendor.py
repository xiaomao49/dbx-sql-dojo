"""Build the PGlite vendor assets: gzip + base64 into a single JS file the sandbox can load."""
import base64
import gzip
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "node_modules", "@electric-sql", "pglite", "dist")
OUT = os.path.join(ROOT, "ui", "vendor", "pglite-assets.js")

FILES = {
    "wasm": "pglite.wasm",
    "initdb": "initdb.wasm",
    "data": "pglite.data",
}


def main():
    parts = []
    total = 0
    for key, name in FILES.items():
        raw = open(os.path.join(DIST, name), "rb").read()
        packed = base64.b64encode(gzip.compress(raw, 9)).decode("ascii")
        total += len(packed)
        print(f"{name:<14} {len(raw)/1024:>8.0f} KB -> base64 {len(packed)/1024:>7.0f} KB")
        parts.append(f'{key}:"{packed}"')

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="ascii") as f:
        f.write("window.PGLITE_ASSETS={")
        f.write(",\n".join(parts))
        f.write("};\n")
    print(f"\ntotal {total/1024/1024:.1f} MB -> {OUT}")


if __name__ == "__main__":
    main()
