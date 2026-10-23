# HL7 v2 over MLLP through python-hl7: its blocking MLLP client sends to the emulator, and its asyncio MLLP server
# receives what the emulator sends.
import asyncio
import threading

import hl7
import pytest
import requests
from hl7.client import MLLPClient
from hl7.mllp import start_hl7_server

MLLP_HOST = "127.0.0.1"


@pytest.fixture(scope="module")
def mllp_port(urls):
    port = requests.get(f"{urls['hl7v2']}/mllp").json()["port"]
    assert port
    return port


def sample(urls, kind, patient):
    return requests.get(f"{urls['hl7v2']}/samples/{kind}", params={"patient": patient}).text


def ack_of(response):
    message = hl7.parse(response.strip(b"\x0b\x1c\r").decode())
    return message.segment("MSA")


def test_admit_and_result(urls, mllp_port):
    with MLLPClient(MLLP_HOST, mllp_port) as client:
        ack = ack_of(client.send_message(sample(urls, "adt-a01", "syn-contract-1")))
        assert str(ack[1]) == "AA"
        ack = ack_of(client.send_message(sample(urls, "oru-r01", "syn-contract-1")))
        assert str(ack[1]) == "AA"
    patient = requests.get(f"{urls['hl7v2']}/patients/syn-contract-1").json()
    assert patient["identifiers"][0]["id"] == "syn-contract-1"
    assert patient["visits"] and patient["observations"]


def test_rejects_garbage(urls, mllp_port):
    with MLLPClient(MLLP_HOST, mllp_port) as client:
        response = client.send_message("MSH|^~\\&|A|B|C|D|20260101000000||ZZZ^Z01|1|P|2.5.1\rZZZ|1")
    assert str(ack_of(response)[1]) in ("AE", "AR")


def test_emulator_sends_to_python_hl7_server(urls):
    received = []
    ready = threading.Event()
    state = {}

    async def handle(reader, writer):
        message = await reader.readmessage()
        received.append(message)
        writer.writemessage(message.create_ack())
        await writer.drain()
        writer.close()

    def serve():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        server = loop.run_until_complete(start_hl7_server(handle, MLLP_HOST, 0))
        state["port"] = server.sockets[0].getsockname()[1]
        state["loop"] = loop
        ready.set()
        loop.run_forever()

    threading.Thread(target=serve, daemon=True).start()
    ready.wait(5)
    try:
        result = requests.post(
            f"{urls['hl7v2']}/send",
            json={"host": MLLP_HOST, "port": state["port"], "message": sample(urls, "adt-a08", "syn-patient-001")},
            timeout=10,
        ).json()
    finally:
        state["loop"].call_soon_threadsafe(state["loop"].stop)
    assert result["ackCode"] == "AA"
    assert str(received[0].segment("MSH")[9][0][0]) == "ADT"
