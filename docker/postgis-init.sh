#!/bin/sh
# Replaces the postgis image's default init script, which also installs
# postgis_topology and postgis_tiger_geocoder. Our first migration creates
# exactly the extensions we use (postgis, pg_trgm), so Prisma sees no drift.
exit 0
