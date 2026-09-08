# Qvidian API Integration — Context & Action Plan

## Goal
Build a Claude agent integration that can query Ab Initio's Qvidian content library programmatically, so that Claude can use approved RFx responses as reference material when drafting new responses to RFPs/RFIs/RFQs.

## What We've Established

### Why Not the MS Office Add-In
The Qvidian MS Office add-in is a UI tool for human use — it cannot be driven by an agent. The correct path is the **Qvidian SOAP API**.

### Qvidian API Architecture
- Qvidian exposes a **SOAP/WSDL API** (not REST)
- Namespace: `http://qvidian.com/webservices/`
- Base endpoint: `https://qpa.qvidian.com/...` (tenant-specific path TBD)
- Authentication is via a **`QvidianCredentialHeader`** SOAP header containing an `AuthenticationToken` string — no username/password in the request body
- Reference WSDL: https://github.com/gve-sw/Qvidian-API-v1/blob/master/wsdl/Common.wsdl

### Authentication Context
- The user's org has **SSO enabled** — login via email only, no password
- The traditional `QvidianAuthentication().Connect(user, password)` method in the Python wrapper will NOT work for this tenant
- Authentication for programmatic access likely uses one of:
  - A **subscriber GUID / API token** provided by Qvidian admin settings
  - A service-level token issued separately from the SSO login flow
- The user has a **subscriber ID/GUID** — this is the likely authentication credential and/or is needed to construct the correct tenant endpoint URL

### Known API Operations (from WSDL)
Confirmed operations in `Common.asmx`:
- `HasPermissions` — check user permissions
- `docTypeList` — list document types
- `templateList` — list templates for a doc type
- `dropDownItemsGetList` — get dropdown/merge code values
- `reportExecuteExcelGet` — run a report and return Excel
- `reportExecuteWithParamsExcelGet` — run a parameterised report

> **Note:** The content library search operations are likely in a separate WSDL (e.g. `Library.asmx` or `Search.asmx`). The existing Python wrapper may already cover these — check the wrapper's available methods first.

### Existing Python Wrapper
An existing Qvidian API wrapper is available in the Claude Code environment. This should be the starting point — do not rewrite from scratch.

## Action Items

### 1. Inspect the Existing Wrapper
- List available classes and methods in the wrapper
- Identify which WSDL services are covered (Common, Library, Search, etc.)
- Check whether authentication supports token-based auth (not just username/password)

### 2. Resolve Authentication
- The user needs to supply their **subscriber GUID** (they have it)
- Determine whether the GUID is:
  a. Passed as the `AuthenticationToken` in the SOAP header, or
  b. Used to construct the tenant-specific endpoint URL (e.g. `https://qpa.qvidian.com/{guid}/Library.asmx`)
  c. Both
- If the wrapper only supports username/password, patch it to accept a token directly

### 3. Test Connectivity
- With the subscriber GUID, make a minimal test call (e.g. `HasPermissions` or `docTypeList`) to verify connectivity and authentication
- Confirm the correct endpoint URL for the tenant

### 4. Identify Content Library Search Operations
- Find the WSDL / service endpoint for searching the content library (likely `Library.asmx` or `Search.asmx`)
- Key operations needed:
  - Search library by keyword/topic
  - Retrieve content item text/metadata
  - Filter by document type or category

### 5. Build an MCP Tool Wrapper
- Wrap the key search + retrieval operations as MCP tools so Claude can call them during a Cowork session
- Suggested tools:
  - `qvidian_search(query: str, doc_type: str = None) -> list[ContentItem]`
  - `qvidian_get_content(item_id: str) -> ContentItem`
- Register as a Cowork plugin

## Credentials Needed (from user)
- [ ] Subscriber GUID / API token
- [ ] Tenant endpoint URL (if known — check Qvidian admin or ask Upland support)

## Reference Links
- Python wrapper (community): https://github.com/gve-sw/Qvidian-API-v1
- Qvidian integrations page: https://uplandsoftware.com/qvidian/integrations/
- SSO integration info: https://support.pingidentity.com/s/marketplace-integration/a7i1W0000004Hl4QAE/qvidian
