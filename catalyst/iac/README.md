# catalyst/iac — Infrastructure-as-Code template for the Catalyst project

`project-template-<version>.json` is the Catalyst IaC template that describes the
Data Store tables/columns this pilot needs. It is **generated** — do not hand-edit:

```bash
node scripts/generate-iac-template.js      # regenerates project-template-1.0.0.json
```

The source of truth is `catalyst/iac/schema.catalyst.js` (curated column definitions
that mirror `src/adapters/store/schema.sql`, translated to Catalyst data types).

## Packing and importing

The Catalyst CLI only accepts a zip whose **root** contains the template named
`project-template-<version>.json` (the name `project-template.json` is rejected with
"No project template found in the zip provided").

```bash
# pack (single file at zip root)
python -c "import zipfile; z=zipfile.ZipFile('var/iac/EcoGreenMigration-iac.zip','w'); z.write('catalyst/iac/project-template-1.0.0.json','project-template-1.0.0.json'); z.close()"

# import = CREATE A NEW PROJECT from the pack (it does not update an existing project)
catalyst iac:import -n <ProjectName> --org <ORG_ID> --dc in --non-interactive var/iac/EcoGreenMigration-iac.zip
```

`iac:import` always creates a **new** project. Additive changes to an existing project
(new tables/columns) are applied through the Catalyst console/API — in this repo that is
done with the generated per-table column batches in `var/iac/columns/` (see
`scripts/generate-iac-template.js --emit-columns`), which are gitignored outputs.

## What must never be committed here

Project IDs, organization IDs, environment IDs, `.catalystrc`, `catalyst.json`,
credentials, or any generated `var/` output. Resource identifiers live only in the
operator's local `.catalystrc` and in reports.
