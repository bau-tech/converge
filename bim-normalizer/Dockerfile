FROM python:3.11-slim

WORKDIR /app

# poppler-utils' pdftoppm — first-page PDF thumbnail rendering
# (pdf_thumbnail.py), a lightweight fallback for when Nextcloud's own
# preview provider can't handle a given PDF. Deliberately not LibreOffice
# (that's still only used, if ever, for DOCX/XLSX, which this doesn't add) —
# pdftoppm is a tiny single-purpose CLI, no office-suite weight or
# concurrency hazard.
RUN apt-get update && apt-get install -y \
    gcc \
    curl \
    make \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# LibreDWG's dwg2dxf — converts uploaded .dwg documents to .dxf on preview
# request (dwg_convert.py), since no free/open library renders DWG directly
# (not packaged in Debian at all; see bim-normalizer/testing-documents.md).
# GPL-3 CLI tool invoked as a subprocess, same pattern as shelling out to
# ffmpeg — doesn't require this project's own code to be GPL. The release
# tarball ships pregenerated configure/Makefile.in, so no autoconf/automake/
# libtool needed. --disable-shared statically links dwg2dxf so it has no
# runtime .so dependency to worry about.
ARG LIBREDWG_VERSION=0.14.8413
RUN curl -sL "https://github.com/LibreDWG/libredwg/releases/download/${LIBREDWG_VERSION}/libredwg-${LIBREDWG_VERSION}.tar.gz" -o /tmp/libredwg.tar.gz \
    && tar -xzf /tmp/libredwg.tar.gz -C /tmp \
    && cd /tmp/libredwg-${LIBREDWG_VERSION} \
    && ./configure --disable-bindings --disable-docs --disable-write --disable-shared \
    && make -j"$(nproc)" \
    && cp programs/dwg2dxf /usr/local/bin/dwg2dxf \
    && cd / && rm -rf /tmp/libredwg.tar.gz /tmp/libredwg-${LIBREDWG_VERSION}

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd -m -u 1000 app && chown -R app:app /app
USER app

EXPOSE 8002
EXPOSE 8003

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8002/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8002", "--workers", "1", "--timeout-keep-alive", "600"]
