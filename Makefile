.PHONY: install dev format format-check lint typecheck test build e2e perf secret-scan deploy model-image clean ai-checks

install:
	pnpm install
	pnpm exec lefthook install
	pnpm exec playwright install chromium

dev:
	pnpm dev

format:
	pnpm format

format-check:
	pnpm format:check

lint:
	pnpm lint

typecheck:
	pnpm check

test:
	pnpm test:coverage

build:
	pnpm build

e2e:
	pnpm test:e2e

perf: build
	pnpm exec lhci autorun

secret-scan:
	@command -v gitleaks > /dev/null || { echo "❌ gitleaks not found: https://github.com/gitleaks/gitleaks#installing"; exit 1; }
	gitleaks git --no-banner --redact

deploy:
	./deploy.sh

model-image:
	./build-model.sh

clean:
	rm -rf build .svelte-kit coverage playwright-report test-results .lighthouseci node_modules

ai-checks: format-check lint typecheck test build
