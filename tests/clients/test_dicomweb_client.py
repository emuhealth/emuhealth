# DICOMweb through dicomweb-client, the reference Python client from the Imaging Data Commons team, with pydicom.
import pydicom
import pytest
from dicomweb_client.api import DICOMwebClient
from pydicom.uid import generate_uid

STUDY = "0020000D"
SERIES = "0020000E"
SOP = "00080018"


@pytest.fixture(scope="module")
def dicom(urls):
    return DICOMwebClient(url=urls["dicomweb"])


def uid(item, tag):
    return item[tag]["Value"][0]


def first_instance(dicom):
    study = uid(dicom.search_for_studies()[0], STUDY)
    series = uid(dicom.search_for_series(study_instance_uid=study)[0], SERIES)
    sop = uid(dicom.search_for_instances(study_instance_uid=study, series_instance_uid=series)[0], SOP)
    return study, series, sop


def test_search(dicom):
    studies = dicom.search_for_studies()
    assert len(studies) >= 2
    filtered = dicom.search_for_studies(search_filters={"ModalitiesInStudy": "CT"})
    assert 0 < len(filtered) <= len(studies)


def test_retrieve(dicom):
    study, series, sop = first_instance(dicom)
    metadata = dicom.retrieve_study_metadata(study)
    assert any(uid(m, SOP) == sop for m in metadata)
    instance = dicom.retrieve_instance(study, series, sop)
    assert isinstance(instance, pydicom.Dataset)
    assert instance.SOPInstanceUID == sop
    assert instance.pixel_array.shape == (instance.Rows, instance.Columns)
    frames = dicom.retrieve_instance_frames(study, series, sop, frame_numbers=[1])
    assert len(frames[0]) == instance.Rows * instance.Columns * instance.BitsAllocated // 8
    rendered = dicom.retrieve_instance_rendered(study, series, sop, media_types=("image/png",))
    assert rendered[:8] == b"\x89PNG\r\n\x1a\n"


def test_store(dicom):
    study, series, sop = first_instance(dicom)
    instance = dicom.retrieve_instance(study, series, sop)
    instance.StudyInstanceUID = generate_uid()
    instance.SeriesInstanceUID = generate_uid()
    instance.SOPInstanceUID = generate_uid()
    instance.file_meta.MediaStorageSOPInstanceUID = instance.SOPInstanceUID
    response = dicom.store_instances(datasets=[instance])
    assert "FailedSOPSequence" not in response
    stored = dicom.retrieve_instance(instance.StudyInstanceUID, instance.SeriesInstanceUID, instance.SOPInstanceUID)
    assert stored.PatientID == instance.PatientID
