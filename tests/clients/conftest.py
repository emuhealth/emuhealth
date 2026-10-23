# Contract tests that drive running emuhealth services with the clients real integrations use.
# Start the services first (see .github/workflows/clients.yml), then run: pytest tests/clients
import os

import pytest


@pytest.fixture(scope="session")
def urls():
    return {
        "fhir": os.environ.get("FHIR_URL", "http://localhost:4100"),
        "dicomweb": os.environ.get("DICOMWEB_URL", "http://localhost:4124"),
        "hl7v2": os.environ.get("HL7V2_URL", "http://localhost:4125"),
        "rave": os.environ.get("RAVE_URL", "http://localhost:4127"),
    }
