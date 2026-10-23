# The FHIR server through fhirclient (SMART on FHIR's Python client), whose models reject unknown or mistyped elements.
import pytest
from fhirclient import client
from fhirclient.models.fhirelementfactory import FHIRElementFactory
from fhirclient.models.observation import Observation
from fhirclient.models.patient import Patient


@pytest.fixture(scope="module")
def smart(urls):
    return client.FHIRClient(settings={"app_id": "emuhealth-contract", "api_base": urls["fhir"]})


def test_capability_statement(smart):
    smart.prepare()
    statement = smart.server.capabilityStatement
    assert statement.fhirVersion == "4.0.1"
    assert any(r.type == "Patient" for r in statement.rest[0].resource)


def test_read_and_search(smart):
    patients = Patient.where(struct={"_count": "50"}).perform_resources(smart.server)
    assert len(patients) >= 5
    patient = Patient.read(patients[0].id, smart.server)
    assert patient.name[0].family
    observations = Observation.where(struct={"patient": patient.id}).perform_resources(smart.server)
    assert observations and all(o.subject.reference == f"Patient/{patient.id}" for o in observations)


def test_every_resource_parses(smart):
    types = [r.type for r in smart.server.capabilityStatement.rest[0].resource]
    parsed = 0
    for resource_type in types:
        bundle = smart.server.request_json(f"{resource_type}?_count=200")
        for entry in bundle.get("entry", []):
            FHIRElementFactory.instantiate(entry["resource"]["resourceType"], entry["resource"])
            parsed += 1
    assert parsed > 300


def test_create_update_delete(smart):
    patient = Patient({"name": [{"family": "Contract", "given": ["Synthetic"]}], "gender": "unknown"})
    created = patient.create(smart.server)
    assert created["id"]
    stored = Patient.read(created["id"], smart.server)
    stored.gender = "other"
    stored.update(smart.server)
    assert Patient.read(created["id"], smart.server).gender == "other"
    stored.delete(smart.server)
