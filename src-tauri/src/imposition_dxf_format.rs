//! Minimal complete R2000 document, including the model-space ownership that
//! CorelDRAW's importer requires. Handles below 0x1000 are reserved here.
use std::fmt::{Display, Write};

pub(super) const MODEL_SPACE: &str = "51";

fn tag(out: &mut String, code: u16, value: impl Display) {
    writeln!(out, "{code}\n{value}").unwrap();
}

fn tags(out: &mut String, values: &[(u16, &str)]) {
    for (code, value) in values {
        tag(out, *code, value);
    }
}

fn table(out: &mut String, name: &str, handle: &str, count: u8) {
    tags(
        out,
        &[
            (0, "TABLE"),
            (2, name),
            (5, handle),
            (330, "0"),
            (100, "AcDbSymbolTable"),
        ],
    );
    tag(out, 70, count);
}

fn symbol(out: &mut String, kind: &str, handle: &str, owner: &str, subclass: &str) {
    tags(
        out,
        &[
            (0, kind),
            (5, handle),
            (330, owner),
            (100, "AcDbSymbolTableRecord"),
            (100, subclass),
        ],
    );
}

pub(super) fn document(entities: &str, count: usize, width: f64, height: f64) -> String {
    let mut out = String::new();
    tags(
        &mut out,
        &[
            (0, "SECTION"),
            (2, "HEADER"),
            (9, "$ACADVER"),
            (1, "AC1015"),
            (9, "$HANDSEED"),
        ],
    );
    tag(&mut out, 5, format!("{:X}", 0x1001 + count));
    tags(
        &mut out,
        &[
            (9, "$DWGCODEPAGE"),
            (3, "ANSI_1252"),
            (9, "$INSUNITS"),
            (70, "4"),
            (9, "$MEASUREMENT"),
            (70, "1"),
            (9, "$LUNITS"),
            (70, "2"),
            (9, "$LUPREC"),
            (70, "6"),
            (9, "$INSBASE"),
            (10, "0"),
            (20, "0"),
            (30, "0"),
            (9, "$EXTMIN"),
            (10, "0"),
            (20, "0"),
            (30, "0"),
            (9, "$EXTMAX"),
        ],
    );
    tag(&mut out, 10, width);
    tag(&mut out, 20, height);
    tag(&mut out, 30, 0);
    tags(
        &mut out,
        &[(9, "$LIMMIN"), (10, "0"), (20, "0"), (9, "$LIMMAX")],
    );
    tag(&mut out, 10, width);
    tag(&mut out, 20, height);
    tags(
        &mut out,
        &[
            (0, "ENDSEC"),
            (0, "SECTION"),
            (2, "CLASSES"),
            (0, "ENDSEC"),
            (0, "SECTION"),
            (2, "TABLES"),
        ],
    );

    table(&mut out, "VPORT", "40", 1);
    symbol(&mut out, "VPORT", "41", "40", "AcDbViewportTableRecord");
    tags(
        &mut out,
        &[
            (2, "*Active"),
            (70, "0"),
            (10, "0"),
            (20, "0"),
            (11, "1"),
            (21, "1"),
        ],
    );
    tag(&mut out, 12, width / 2.0);
    tag(&mut out, 22, height / 2.0);
    tags(
        &mut out,
        &[
            (16, "0"),
            (26, "0"),
            (36, "1"),
            (17, "0"),
            (27, "0"),
            (37, "0"),
        ],
    );
    tag(&mut out, 40, height);
    tag(&mut out, 41, width / height);
    tags(
        &mut out,
        &[
            (42, "50"),
            (43, "0"),
            (44, "0"),
            (50, "0"),
            (51, "0"),
            (71, "0"),
            (72, "100"),
            (73, "1"),
            (74, "3"),
            (75, "0"),
            (76, "0"),
            (77, "0"),
            (78, "0"),
            (0, "ENDTAB"),
        ],
    );

    table(&mut out, "LTYPE", "10", 3);
    for (handle, name) in [("11", "CONTINUOUS"), ("12", "ByBlock"), ("13", "ByLayer")] {
        symbol(&mut out, "LTYPE", handle, "10", "AcDbLinetypeTableRecord");
        tags(
            &mut out,
            &[
                (2, name),
                (70, "0"),
                (3, "Solid line"),
                (72, "65"),
                (73, "0"),
                (40, "0"),
            ],
        );
    }
    tag(&mut out, 0, "ENDTAB");
    table(&mut out, "LAYER", "20", 3);
    for (handle, name) in [("21", "0"), ("22", "CUT"), ("23", "HOLES")] {
        symbol(&mut out, "LAYER", handle, "20", "AcDbLayerTableRecord");
        tags(
            &mut out,
            &[(2, name), (70, "0"), (62, "1"), (6, "CONTINUOUS")],
        );
    }
    tag(&mut out, 0, "ENDTAB");
    table(&mut out, "STYLE", "30", 1);
    symbol(&mut out, "STYLE", "31", "30", "AcDbTextStyleTableRecord");
    tags(
        &mut out,
        &[
            (2, "Standard"),
            (70, "0"),
            (40, "0"),
            (41, "1"),
            (50, "0"),
            (71, "0"),
            (42, "2.5"),
            (3, "txt"),
            (4, ""),
            (0, "ENDTAB"),
        ],
    );
    for (name, handle) in [("VIEW", "42"), ("UCS", "43")] {
        table(&mut out, name, handle, 0);
        tag(&mut out, 0, "ENDTAB");
    }
    table(&mut out, "APPID", "44", 1);
    symbol(&mut out, "APPID", "45", "44", "AcDbRegAppTableRecord");
    tags(&mut out, &[(2, "ACAD"), (70, "0"), (0, "ENDTAB")]);
    table(&mut out, "DIMSTYLE", "46", 0);
    tags(&mut out, &[(100, "AcDbDimStyleTable"), (0, "ENDTAB")]);
    table(&mut out, "BLOCK_RECORD", "50", 2);
    for (handle, name) in [(MODEL_SPACE, "*Model_Space"), ("52", "*Paper_Space")] {
        symbol(
            &mut out,
            "BLOCK_RECORD",
            handle,
            "50",
            "AcDbBlockTableRecord",
        );
        tags(&mut out, &[(2, name), (70, "0")]);
    }
    tags(
        &mut out,
        &[(0, "ENDTAB"), (0, "ENDSEC"), (0, "SECTION"), (2, "BLOCKS")],
    );
    for (name, owner, begin, end) in [
        ("*Model_Space", MODEL_SPACE, "53", "54"),
        ("*Paper_Space", "52", "55", "56"),
    ] {
        tags(
            &mut out,
            &[
                (0, "BLOCK"),
                (5, begin),
                (330, owner),
                (100, "AcDbEntity"),
                (8, "0"),
                (100, "AcDbBlockBegin"),
                (2, name),
                (70, "0"),
                (10, "0"),
                (20, "0"),
                (30, "0"),
                (3, name),
                (1, ""),
                (0, "ENDBLK"),
                (5, end),
                (330, owner),
                (100, "AcDbEntity"),
                (8, "0"),
                (100, "AcDbBlockEnd"),
            ],
        );
    }
    tags(&mut out, &[(0, "ENDSEC"), (0, "SECTION"), (2, "ENTITIES")]);
    out.push_str(entities);
    tags(
        &mut out,
        &[
            (0, "ENDSEC"),
            (0, "SECTION"),
            (2, "OBJECTS"),
            (0, "DICTIONARY"),
            (5, "60"),
            (330, "0"),
            (100, "AcDbDictionary"),
            (281, "1"),
            (3, "ACAD_GROUP"),
            (350, "61"),
            (0, "DICTIONARY"),
            (5, "61"),
            (330, "60"),
            (100, "AcDbDictionary"),
            (281, "1"),
            (0, "ENDSEC"),
            (0, "EOF"),
        ],
    );
    out.replace('\n', "\r\n")
}
