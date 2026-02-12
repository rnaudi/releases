# releases

Track how often your team ships. Point it at your GitHub repos, get a dashboard.

<img width="1279" height="1914" alt="Screenshot 2026-02-12 at 18 03 11" src="https://github.com/user-attachments/assets/236499f8-250b-433c-bb64-f432e3aea449" />


## Prerequisites

```bash
brew install deno gh
gh auth login
```

## Quick Start

```bash
cp config.example.yaml config.yaml
vim config.yaml          # add your repos
./make.ts
```

## Configuration

`config.example.yaml` shows the format:

```yaml
projects:
  - id: my-api
    name: My API
    repo: my-org/my-api
    base: main
```

| Field  | Description                              |
|--------|------------------------------------------|
| `id`   | URL-safe key (filenames, URL hash)       |
| `name` | Display name in dashboard tabs           |
| `repo` | GitHub `owner/repo`                      |
| `base` | Branch that release PRs target           |

## Usage

```bash
./make.ts              # generate dashboard, open in browser
./make.ts --fresh      # re-fetch all data from GitHub
./make.ts --no-open    # generate without opening browser
```

Data is cached in `data/`. Delete a CSV to re-fetch a single project.
