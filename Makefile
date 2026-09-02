.PHONY: check licenses release mint

check:
	cd frontend && CI=true pnpm run typecheck
	cd frontend && CI=true pnpm test
	./gradlew test

# Regenerates the bundled-dependency license list from the freshly built frontend bundle.
# `release` rebuilds the bundle a second time through Gradle's frontendBuild; that is just a few
# seconds and keeps this target usable on its own.
licenses:
	cd frontend && CI=true pnpm run build
	node scripts/collect-third-party-licenses.mjs

release: check licenses
	@list=src/main/resources/third-party/BUNDLED-LICENSES.md; \
	if [ -n "$$(git status --porcelain -- $$list)" ]; then \
		echo "$$list is out of date in git; review and commit the regenerated list." >&2; \
		exit 1; \
	fi
	./gradlew buildPlugin
	@version=$$(sed -n 's/^pluginVersion[[:space:]]*=[[:space:]]*//p' gradle.properties); \
	artifact="build/distributions/milkj-$$version.zip"; \
	test -f "$$artifact"; \
	unzip -tq "$$artifact"; \
	shasum -a 256 "$$artifact"

mint:
	node scripts/increment-version.mjs
	$(MAKE) release
