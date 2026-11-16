module example.test/kettle-app

go 1.22

require (
	example.test/fict/express-lite v4.0.0
	example.test/fict/tiny-fmt v1.2.0 // indirect
	example.test/fict/req-cli v2.0.0
	example.test/fict/hashy v3.1.0
	example.test/fict/dual-lib v1.0.0
	example.test/fict/gpl-widget v2.2.0
	example.test/fict/lgpl-codec v0.9.0
	example.test/fict/old-parse v1.0.1
	example.test/fict/internal-sdk v5.0.0
	example.test/fict/custom-fonts v1.0.0
	example.test/fict/mpl-thing v2.0.0
	example.test/fict/icons-cc v1.0.0
	example.test/fict/nolicense-pkg v0.1.0
	example.test/fict/expired-ex v1.0.0
	example.test/fict/logger v1.0.0
	example.test/fict/my-plugin v0.0.0
)

replace example.test/fict/my-plugin => ../my-plugin
