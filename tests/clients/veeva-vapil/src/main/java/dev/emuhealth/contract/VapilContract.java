package dev.emuhealth.contract;

import com.veeva.vault.vapil.api.client.VaultClient;
import com.veeva.vault.vapil.api.model.common.Document;
import com.veeva.vault.vapil.api.model.response.DocumentResponse;
import com.veeva.vault.vapil.api.model.response.MetaDataObjectResponse;
import com.veeva.vault.vapil.api.model.response.ObjectRecordBulkResponse;
import com.veeva.vault.vapil.api.model.response.ObjectRecordResponse;
import com.veeva.vault.vapil.api.model.response.QueryResponse;
import com.veeva.vault.vapil.api.model.response.VaultResponse;
import com.veeva.vault.vapil.api.request.DocumentRequest;
import com.veeva.vault.vapil.api.request.MetaDataRequest;
import com.veeva.vault.vapil.api.request.ObjectRecordRequest;
import com.veeva.vault.vapil.api.request.QueryRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

/** Drives the emuhealth Vault emulator with VAPIL. Usage: VapilContract [vaultDNS], default localhost:8443. */
public class VapilContract {
  private static int checks = 0;

  private static void check(boolean condition, String what) {
    if (!condition) throw new AssertionError("Failed: " + what);
    checks++;
    System.out.println("ok " + what);
  }

  private static VaultClient client(String dns, String password) {
    return VaultClient.newClientBuilder(VaultClient.AuthenticationType.BASIC)
        .withVaultDNS(dns)
        .withVaultUsername("admin@synthetic-vault.example")
        .withVaultPassword(password)
        .withVaultClientId("emuhealth-contract")
        .build();
  }

  public static void main(String[] args) throws Exception {
    String dns = args.length > 0 ? args[0] : "localhost:8443";

    VaultClient bad = client(dns, "wrong-password");
    check(!bad.getAuthenticationResponse().isSuccessful(), "a wrong password does not authenticate");
    check(
        bad.getAuthenticationResponse().getErrors().get(0).getType().equals("USERNAME_OR_PASSWORD_INCORRECT"),
        "a wrong password reports USERNAME_OR_PASSWORD_INCORRECT");

    // VAPIL validates the session by matching GET /api against its own API version URL.
    VaultClient vault = client(dns, "synthetic-password");
    check(vault.getAuthenticationResponse().isSuccessful(), "password sign in and session validation");

    QueryResponse sites =
        vault.newRequest(QueryRequest.class).query("SELECT id, name__v, site_status__v FROM site__v PAGESIZE 2");
    check(sites.isSuccessful() && sites.getData().size() == 2, "VQL query with PAGESIZE");
    check(sites.getData().get(0).get("name__v") != null, "VQL rows carry the selected fields");
    String next = sites.getResponseDetails().getNextPage();
    check(next != null, "VQL next_page is present");
    QueryResponse page = vault.newRequest(QueryRequest.class).queryByPage(next);
    check(page.isSuccessful() && !page.getData().isEmpty(), "VQL next_page through queryByPage");

    MetaDataObjectResponse metadata = vault.newRequest(MetaDataRequest.class).retrieveObjectMetadata("product__v");
    check(metadata.isSuccessful(), "object metadata for product__v");

    ObjectRecordBulkResponse created = vault.newRequest(ObjectRecordRequest.class)
        .setContentTypeJson()
        .setRequestString("[{\"name__v\":\"VAPIL Contract\",\"generic_name__c\":\"vapilumab\"}]")
        .createAndUpsertObjectRecords("product__v");
    check(created.isSuccessful() && created.getData().get(0).isSuccessful(), "create a product__v record");
    String id = created.getData().get(0).getData().getId();

    ObjectRecordResponse record = vault.newRequest(ObjectRecordRequest.class).retrieveObjectRecord("product__v", id);
    check(record.isSuccessful() && "VAPIL Contract".equals(record.getData().get("name__v")), "retrieve the record");

    ObjectRecordBulkResponse updated = vault.newRequest(ObjectRecordRequest.class)
        .setContentTypeJson()
        .setRequestString("[{\"id\":\"" + id + "\",\"generic_name__c\":\"vapilumab-b\"}]")
        .updateObjectRecords("product__v");
    check(updated.isSuccessful() && updated.getData().get(0).isSuccessful(), "update the record");

    ObjectRecordBulkResponse deleted = vault.newRequest(ObjectRecordRequest.class)
        .setContentTypeJson()
        .setRequestString("[{\"id\":\"" + id + "\"}]")
        .deleteObjectRecords("product__v");
    check(deleted.isSuccessful() && deleted.getData().get(0).isSuccessful(), "delete the record");

    byte[] content = "Synthetic VAPIL contract document".getBytes(StandardCharsets.UTF_8);
    Path file = Files.createTempFile("vapil-contract", ".txt");
    Files.write(file, content);
    Document doc = new Document();
    doc.setName("VAPIL Contract Document");
    doc.setType("General");
    doc.setLifecycle("General Lifecycle");
    DocumentResponse createdDoc =
        vault.newRequest(DocumentRequest.class).setInputPath(file.toString()).createSingleDocument(doc);
    check(createdDoc.isSuccessful(), "create a document with a file");
    int docId = createdDoc.getDocument().getId();

    DocumentResponse readDoc = vault.newRequest(DocumentRequest.class).retrieveDocument(docId);
    check(
        readDoc.isSuccessful() && "VAPIL Contract Document".equals(readDoc.getDocument().getName()),
        "retrieve the document");
    VaultResponse download = vault.newRequest(DocumentRequest.class).downloadDocumentFile(docId);
    check(Arrays.equals(download.getBinaryContent(), content), "download the document file");

    System.out.println(checks + " checks passed");
  }
}
