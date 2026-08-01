.PHONY: check release mint

check:
	cd frontend && CI=true pnpm run typecheck
	cd frontend && CI=true pnpm test
	./gradlew test

release: check
	./gradlew buildPlugin
	@version=$$(sed -n 's/^pluginVersion[[:space:]]*=[[:space:]]*//p' gradle.properties); \
	artifact="build/distributions/milkj-$$version.zip"; \
	test -f "$$artifact"; \
	unzip -tq "$$artifact"; \
	shasum -a 256 "$$artifact"

mint:
	node scripts/increment-version.mjs
	$(MAKE) release
