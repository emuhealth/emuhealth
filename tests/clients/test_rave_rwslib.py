# Medidata Rave Web Services through rwslib, Medidata's own Python client.
import pytest
from rwslib import RWSConnection
from rwslib.builders import ClinicalData, FormData, ItemData, ItemGroupData, ODM, StudyEventData, SubjectData
from rwslib.rws_requests import (
    ClinicalStudiesRequest,
    PostDataRequest,
    StudyDatasetRequest,
    StudySubjectsRequest,
    StudyVersionRequest,
    StudyVersionsRequest,
    SubjectDatasetRequest,
    TwoHundredRequest,
    VersionRequest,
)
from rwslib.rws_requests.odm_adapter import AuditRecordsRequest
from rwslib.rwsobjects import RWSException


@pytest.fixture(scope="module")
def rave(urls):
    return RWSConnection(urls["rave"], "rws.synthetic", "synthetic-password")


def test_unauthenticated_routes(rave):
    assert rave.send_request(VersionRequest())
    assert rave.send_request(TwoHundredRequest())


def test_bad_credentials(urls):
    with pytest.raises(RWSException) as error:
        RWSConnection(urls["rave"], "rws.synthetic", "wrong").send_request(ClinicalStudiesRequest())
    assert "RWS00008" in str(error.value.rws_error.errordescription)


def test_studies_and_metadata(rave):
    studies = rave.send_request(ClinicalStudiesRequest())
    assert {s.oid for s in studies} >= {"EMU-101", "EMU-101(UAT)", "EMU-202", "EMU-202(UAT)"}
    versions = rave.send_request(StudyVersionsRequest("EMU-101"))
    assert [v.oid for v in versions] == ["1001"]
    metadata = rave.send_request(StudyVersionRequest("EMU-101", 1001))
    assert 'OID="VS.PULSE"' in metadata


def test_subjects(rave):
    subjects = rave.send_request(StudySubjectsRequest("EMU-101", "Prod", status=True, links=True))
    assert len(subjects) == 8
    assert subjects[0].subjectkey == "101-001"
    assert subjects[0].locationoid
    uuids = rave.send_request(StudySubjectsRequest("EMU-101", "Prod", subject_key_type="SubjectUUID"))
    # rwslib lowercases the mdsol status attributes it reads, SubjectKeyType included.
    assert uuids[0].subjectkeytype == "subjectuuid"


def test_datasets(rave):
    data = rave.send_request(StudyDatasetRequest("EMU-101", "Prod", "regular", formoid="VS"))
    assert 'ItemOID="VS.PULSE"' in data
    one = rave.send_request(SubjectDatasetRequest("EMU-101", "Prod", "101-001", "regular"))
    assert 'SubjectKey="101-001"' in one


def test_post_clinical_data_and_audit(rave):
    odm = ODM("emuhealth-contract")(
        ClinicalData("EMU-101", "Prod")(
            SubjectData("SYN-SITE-101", "101-950", transaction_type="Insert")(
                StudyEventData("SCREENING")(
                    FormData("VS", transaction_type="Update")(ItemGroupData()(ItemData("VS.PULSE", "64")))
                )
            )
        )
    )
    response = rave.send_request(PostDataRequest(str(odm)))
    assert response.istransactionsuccessful
    assert response.subjects_touched == 1
    assert response.fields_touched >= 1

    duplicate = ODM("emuhealth-contract")(
        ClinicalData("EMU-101", "Prod")(SubjectData("SYN-SITE-101", "101-950", transaction_type="Insert"))
    )
    with pytest.raises(RWSException) as error:
        rave.send_request(PostDataRequest(str(duplicate)))
    assert error.value.rws_error.reason_code == "RWS00024"

    bad = ODM("emuhealth-contract")(
        ClinicalData("EMU-101", "Prod")(
            SubjectData("SYN-SITE-101", "101-950", transaction_type="Update")(
                StudyEventData("SCREENING")(
                    FormData("VS", transaction_type="Update")(ItemGroupData()(ItemData("VS.PULSE", "fast")))
                )
            )
        )
    )
    with pytest.raises(RWSException) as error:
        rave.send_request(PostDataRequest(str(bad)))
    rejected = error.value.rws_error
    assert type(rejected).__name__ == "RWSPostErrorResponse"
    assert rejected.istransactionsuccessful is False
    assert rejected.reason_code and rejected.error_origin_location

    audits = rave.send_request(AuditRecordsRequest("EMU-101", "Prod", startid=1, per_page=1000))
    assert "AuditRecord" in audits and 'Value="64"' in audits
