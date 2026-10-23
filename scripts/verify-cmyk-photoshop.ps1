param(
    [Parameter(Mandatory = $true)]
    [string[]]$PdfPaths,
    [switch]$ExpectWindowLayers
)

# Optional Windows integration check. Photoshop is a verification dependency,
# not a dependency of the application's native CMYK exporter.
$ErrorActionPreference = 'Stop'
$taskFiles = @($PdfPaths | ForEach-Object { (Resolve-Path -LiteralPath $_).Path.Replace('\', '/') })
$taskFileJson = ConvertTo-Json -InputObject $taskFiles -Compress
$taskScript = @'
(function () {
    var files = __FILES__, previous = app.documents.length ? app.activeDocument : null;
    var dialogs = app.displayDialogs, results = [], failure = false;
    app.displayDialogs = DialogModes.NO;
    try {
        for (var i = 0; i < files.length; i++) {
            var doc = null;
            try {
                doc = app.open(new File(files[i]));
                var expected = ['White', 'C2', 'M2', 'Y2', 'K2'], names = [];
                if (doc.channels.length !== 9) throw new Error('Expected 9 ink channels, found ' + doc.channels.length);
                for (var j = 0; j < doc.channels.length; j++) {
                    var channel = doc.channels[j];
                    names.push(channel.name);
                    if (j < 4 && channel.kind !== ChannelType.COMPONENT) throw new Error('Process channel kind is incorrect');
                    if (j >= 4 && (channel.kind !== ChannelType.SPOTCOLOR || channel.name !== expected[j - 4] || channel.opacity !== 100))
                        throw new Error('Spot name, order or density is incorrect at channel ' + (j + 1));
                    if (j >= 4) {
                        var color = channel.color.cmyk, values = [color.cyan, color.magenta, color.yellow, color.black];
                        var ink = j === 4 ? 3 : j - 5;
                        for (var k = 0; k < 4; k++) if (Math.abs(values[k] - (k === ink ? 100 : 0)) > 0.01)
                            throw new Error('Spot display color is incorrect for ' + channel.name);
                    }
                }
                if (__EXPECT_LAYERS__ && (doc.layers.length !== 2 || doc.layers[0].name !== '图片' || doc.layers[1].name !== '彩窗'))
                    throw new Error('Expected independent picture above merged window, found ' + doc.layers.length + ' layers');
                var layerNames = []; for (var l = 0; l < doc.layers.length; l++) layerNames.push(doc.layers[l].name);
                results.push('PASS ' + files[i] + '\n  ' + names.join(' | ') + '\n  Layers: ' + layerNames.join(' | ') + '\n  ' + doc.resolution + ' ppi; ' + doc.colorProfileName);
            } catch (error) {
                failure = true;
                results.push('FAIL ' + files[i] + '\n  ' + error.message);
            } finally {
                if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
            }
        }
        return (failure ? 'FAILED\n' : 'PASSED\n') + results.join('\n');
    } finally {
        app.displayDialogs = dialogs;
        if (previous) app.activeDocument = previous;
    }
})()
'@
$taskPhotoshop = New-Object -ComObject Photoshop.Application
$taskResult = $taskPhotoshop.DoJavaScript($taskScript.Replace('__FILES__', $taskFileJson).Replace('__EXPECT_LAYERS__', $ExpectWindowLayers.IsPresent.ToString().ToLowerInvariant()))
Write-Output $taskResult
if ($taskResult.StartsWith('FAILED')) { throw 'Photoshop CMYK channel verification failed.' }
