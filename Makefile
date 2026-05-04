PI_BIN := pi

build:
	npx tsc --noEmit
.PHONY: build

compile:
	npx tsc
.PHONY: compile

test-integration:
	PI_BIN=$(PI_BIN) python3 ./tests/pi_integration_test.py
.PHONY: test-integration

precommit: build test-integration
.PHONY: precommit
