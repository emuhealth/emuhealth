# The emuhealth CLI as a container image, built from the published npm package by the release workflow.
# docker run --rm -p 4100:4100 ghcr.io/emuhealth/emuhealth start --service fhir
FROM node:24-alpine

ARG VERSION
RUN test -n "$VERSION" && npm install --global --no-audit --no-fund "emuhealth@${VERSION}" && npm cache clean --force

LABEL org.opencontainers.image.title="emuhealth" \
      org.opencontainers.image.description="Local, stateful emulators for healthcare and life science APIs. Synthetic data only." \
      org.opencontainers.image.source="https://github.com/emuhealth/emuhealth" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"

# Mount a config at /app/emuhealth.config.yaml; the CLI finds it in the working directory.
WORKDIR /app
USER node

# Health services use base port 4000 + 100 and up; HL7 v2 also listens for MLLP on 2575.
EXPOSE 4100-4130 2575

ENTRYPOINT ["emuhealth"]
CMD ["start", "--host", "0.0.0.0"]
