# Resource Library Migration Bundle

Generated: 20260728

This bundle contains 455 sanitized backlink resources.
It includes source provenance, category, DataForSEO quality metrics, and resource metadata.
It intentionally excludes private supplier pricing, private notes, contacts, credentials, and API keys.

## Import

```powershell
python .\import_resources.py --output .\data\resources.json
```

To replace an existing JSON resource store instead of merging by normalized domain:

```powershell
python .\import_resources.py --output .\data\resources.json --replace
```

Inventory: free=275, paid=180, total=455.
Quality buckets: recommend=83, review=41, avoid=47, unclassified=284.
