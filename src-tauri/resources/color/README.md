# 生产 CMYK 配置

`250icm.icc` 为用户指定的生产输出配置，内部名称 `250.icm`，ICC 4.3，CMYK → Lab，4,324,768 字节。

来源：`\\192.168.0.66\电商文件\公司员工\霍芃箔\250icm.icc`。

SHA-256：`d3601f736c48c67ffcdfd75fc7b0977d7115619ece89f39194fac091cffae16a`。

该配置通过 `include_bytes!` 编入导出核心，安装后不需要连接共享目录。更新生产配置时需核验文件、更新哈希回归检查，并重新构建。

ICC 转换使用静态链接的 LittleCMS 2（lcms2 / lcms2-sys，MIT），专色 PDF 使用 pdf-writer（MIT / Apache-2.0），Flate 无损压缩使用 flate2（MIT / Apache-2.0）。
