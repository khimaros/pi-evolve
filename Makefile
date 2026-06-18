TS_SOURCES := $(shell find src -name '*.ts' 2>/dev/null)
PI_BIN     := pi

.PHONY: build lint test test-integration precommit install update pack publish clean

.DEFAULT_GOAL := build

# no build step: pi loads src/extension/index.ts directly via its jiti loader
# (a pure extension, no bin). "build" type-checks the source.
build: node_modules
	@npm run typecheck

node_modules: package.json package-lock.json
	@npm install
	@touch node_modules

lint: node_modules
	@echo "==> lint"
	@npx tsc --noEmit

test: test-integration

test-integration: build
	@echo "==> integration test"
	@PI_BIN=$(PI_BIN) python3 ./tests/pi_integration_test.py

precommit: lint test

install:
	@npm install -g .

pack: build
	@mkdir -p build
	@npm pack --pack-destination build

publish: build
	@npm publish --access public

update:
	@npm update
	@touch node_modules

clean:
	@rm -rf dist build tests/.artifacts
