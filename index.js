#!/usr/bin/env node --harmony
/**
 * Created by igorgo on 02.07.2017.
 */
const
    inquirer = require('inquirer'),
    oracledb = require('oracledb'),
    conU = require('log-update'),
    program = require('commander'),
    xpath = require('xpath'),
    dom = require('xmldom').DOMParser,
    tomlify = require('tomlify-j0.4'),
    fs = require('fs-extra')
let oci
oracledb.maxRows = 10000
// oracledb.fetchAsBuffer = [oracledb.BLOB]
//  oracledb.fetchAsString = [oracledb.CLOB]
oracledb.outFormat = oracledb.OBJECT // {outFormat : oracledb.ARRAY}

/* const fixNum = (a) => {
 return a ? a.toFixed(0) : null
 } */

function coalesce(...values) {
    for (let i = 0; i < values.length; i++) {
        if (values[i] !== null && values[i] !== undefined) {
            return values[i]
        }
    }
    return null
}

const main = async () => {
    let params = await askParams()
    oci = await connectDB(params.username, params.password, params.dbname)
    await exportClass(params.singleClass, params.directory)
    return await closeConnection()
}

const exportClass = async (classCode, dir) => {
    const getClassRn = async (classCode) => {
        conU('... get reg num of class')
        let r = await oci.execute(
            'select RN from UNITLIST where UNITCODE = :CLASSCODE', [classCode]
        )
        if (r.rows.length > 0) {
            return r.rows[0].RN
        }
        else {
            //Promise.reject(new Error('Class not found', 1))
            throw 'Class not found'
        }
    }
    const saveIcons = async () => {
        conU('... saving the icons')
        let query = await oci.execute(`
            select SY.*
              from SYSIMAGES SY
             where RN in (
                          
                          select T.RN
                            from SYSIMAGES T
                           where exists (select null
                                    from UNITLIST UL
                                   where UL.RN = :WORKIN_CLASS
                                     and UL.SYSIMAGE = T.RN)
                          union
                          select T.RN
                            from SYSIMAGES T
                           where exists (select null
                                    from UNITFUNC UF
                                   where UF.PRN = :WORKIN_CLASS
                                     and UF.SYSIMAGE = T.RN)
                          union
                          select T.RN
                            from SYSIMAGES T
                           where exists (select null
                                    from UNIT_SHOWMETHODS US
                                   where US.PRN = :WORKIN_CLASS
                                     and US.SYSIMAGE = T.RN))
        `, [classRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            let icon = query.rows[i]
            await saveLob(icon.SMALL_IMAGE, `${classDir}/icons`, `${icon.CODE}__16.bmp`)
            await saveLob(icon.LARGE_IMAGE, `${classDir}/icons`, `${icon.CODE}__24.bmp`)
        }
    }
    const createDomainsTable = async () => {
        const getMetaDomainList = async () => {
            conU('... get list of metadata\'s domains')
            let r = await oci.execute(`
                select CODE
                  from DMSDOMAINS
                 where RN in (select DOMAIN
                                from DMSCLATTRS
                               where PRN = :CLASSRN
                              union
                              select DOMAIN
                                from DMSCLACTIONSPRM T, UNITFUNC F
                               where F.PRN = :CLASSRN
                                 and T.PRN = F.RN
                              union
                              select DOMAIN
                                from DMSCLMETPARMS T, DMSCLMETHODS M
                               where M.PRN = :CLASSRN
                                 and T.PRN = M.RN
                              union
                              select DOMAIN
                                from DMSCLVIEWSPARAMS T, DMSCLVIEWS V
                               where V.PRN = :CLASSRN
                                 and T.PRN = V.RN)
               `,
                [classRn]
            )
            return r.rows.map((row) => {
                return row.CODE
            })
        }
        const getCondDomainList = async () => {
            conU('... get list of conditions\' domains')
            let r = await oci.execute(`
                select settings as SETS
                  from UNIT_SHOWMETHODS
                 where PRN = :CLASSRN
                   and LENGTH(SETTINGS) > 0
               `,
                [classRn], {
                    fetchInfo: {'SETS': {type: oracledb.STRING}}
                }
            )
            let res = []
            let nodeVals
            for (let i = 0; i < r.rows.length; i++) {
                let doc = new dom().parseFromString(r.rows[i].SETS)
                let nodes = xpath.select('/ShowMethod/Group/DataSource/Params/ConditionParams/Param/@Domain', doc)
                nodeVals = nodes.map((node) => {
                    return node.value
                })
                res = res.concat(nodeVals)
            }
            return res
        }
        let domainsMeta = await getMetaDomainList()
        let domainsCond = await getCondDomainList()
        let domains = [...new Set(domainsMeta.concat(domainsCond))].sort()
        let domainsData = []
        for (let i = 0; i < domains.length; i++) {
            let r = await oci.execute(`
                 select D.RN,
                        D.CODE,
                        DT.DATATYPE_TEXT,
                        DT.DATATYPE_SUBTEXT,
                        D.DATA_LENGTH,
                        D.DATA_PRECISION,
                        D.DATA_SCALE,
                        D.DEFAULT_STR,
                        D.DEFAULT_NUM,
                        D.DEFAULT_DATE,
                        D.ENUMERATED,
                        D.PADDING
                   from DMSDOMAINS D, V_DATATYPES DT
                  where D.CODE = :DOMAINCODE
                    and D.DATA_TYPE = DT.DATATYPE_NUMB
                    and D.DATA_SUBTYPE = DT.DATATYPE_SUBNUMB            
            `, [domains[i]])
            let domain = r.rows[0]
            let name = await getResources(domain.RN, 'DMSDOMAINS', 'NAME')
            let objDomain = {
                'Мнемокод': domain.CODE,
                'Наименование (RU)': name.RU,
                'Наименование (UK)': name.UK,
                'Тип данных': domain.DATATYPE_TEXT,
                'Подтип данных': domain.DATATYPE_SUBTEXT,
                'Размер строки': domain.DATA_LENGTH,
                'Точность данных': domain.DATA_PRECISION,
                'Дробность данных': domain.DATA_SCALE,
                'Значение по умолчанию': coalesce(domain.DEFAULT_STR, domain.DEFAULT_NUM, domain.DEFAULT_DATE),
                'Выравнивать по длине': !!domain.PADDING,
                'Имеет перечисляемые значения': !!domain.ENUMERATED,
            }
            if (domain.ENUMERATED) {
                let enumRows = await oci.execute(`
                    select RN,
                           POSITION,
                           VALUE_STR,
                           VALUE_NUM,
                           VALUE_DATE
                      from DMSENUMVALUES T
                     where PRN = :PRN
                     order by POSITION                
                `, [domain.RN])
                let enumsData = []
                for (let i = 0; i < enumRows.rows.length; i++) {
                    let enumRow = enumRows.rows[i]
                    let enumName = await getResources(enumRow.RN, 'DMSENUMVALUES', 'NAME')
                    let objEnum = {
                        'Позиция': enumRow.POSITION.trim(),
                        'Значение': coalesce(enumRow.VALUE_STR, enumRow.VALUE_NUM, enumRow.VALUE_DATE),
                        'Наименование (RU)': enumName.RU,
                        'Наименование (UK)': enumName.UK,
                    }
                    enumsData.push(objEnum)
                }
                objDomain['Перечисляемые значения'] = {
                    'Перечисляемое значение': enumsData
                }
            }
            domainsData.push(objDomain)
        }
        return domainsData
    }
    const createClassTable = async () => {
        let classObject
        let getTableObj = async (tableName) => {
            conU('... get table definition')
            let query = await oci.execute('select TL.* from TABLELIST TL where TL.TABLENAME = :TABLENAME', [tableName])
            let res = query.rows[0]
            let names = await getResources(res.RN, 'TABLELIST', 'TABLENOTE')
            return {
                'Имя': res.TABLENAME,
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Тип информации': ['Постоянная', 'Временная'][res.TEMPFLAG],
                'Технология производства': ['Стандарт', 'Конструктор'][res.TECHNOLOGY]
            }
        }
        let getAttribs = async () => {
            conU('... get attributes\' metadata')
            let attrsQuery = await oci.execute(`
                select CA.*,
                       DM.CODE            as SDOMAIN,
                       CL.CONSTRAINT_NAME as SREF_LINK,
                       CAR.COLUMN_NAME    as SREF_ATTRIBUTE
                  from DMSCLATTRS CA, DMSDOMAINS DM, DMSCLLINKS CL, DMSCLATTRS CAR
                 where CA.PRN = :CLASSRN
                   and CA.DOMAIN = DM.RN
                   and CA.REF_LINK = CL.RN(+)
                   and CA.REF_ATTRIBUTE = CAR.RN(+)
                 order by CA.POSITION                           
            `, [classRn])
            let attrs = []
            for (let i = 0, len = attrsQuery.rows.length; i < len; i++) {
                let attr = attrsQuery.rows[i]
                let names = await getResources(attr.RN, 'DMSCLATTRS', 'CAPTION')
                attrs.push({
                    'Имя': attr.COLUMN_NAME,
                    'Наименование (RU)': names.RU,
                    'Наименование (UK)': names.UK,
                    'Позиция': attr.POSITION,
                    'Тип': ['Физический', 'Логический', 'Получен по связи'][attr.KIND],
                    'Домен': attr.SDOMAIN,
                    'Связь': attr.SREF_LINK,
                    'Атрибут связи': attr.SREF_ATTRIBUTE
                })
            }
            return attrs
        }
        let getConstraints = async () => {
            conU('... get constraints\' metadata')
            let constrsQuery = await oci.execute(`
                select T.*,
                       MES.CODE       as MES_CODE,
                       MES.TECHNOLOGY as MES_TECHNOLOGY,
                       MES.KIND       as MES_KIND
                  from DMSCLCONSTRS T, DMSMESSAGES MES
                 where T.PRN = :CLASSRN
                   and T.MESSAGE = MES.RN(+)
                 order by T.CONSTRAINT_TYPE, T.CONSTRAINT_NAME
            `, [classRn])
            let constrs = []
            for (let i = 0, len = constrsQuery.rows.length; i < len; i++) {
                let constr = constrsQuery.rows[i]
                let names = await getResources(constr.RN, 'DMSCLCONSTRS', 'CONSTRAINT_NOTE')
                let messages = await getResources(constr.MESSAGE, 'DMSMESSAGES', 'TEXT')
                let getConstrAttrs = async (constrRn) => {
                    let query = await oci.execute(`
                        select T.POSITION, TR1.COLUMN_NAME
                          from DMSCLCONATTRS T, DMSCLATTRS TR1
                         where T.PRN = :A_CONS
                           and T.ATTRIBUTE = TR1.RN
                         order by T.POSITION
                     `, [constrRn])
                    /* for (let i=0, l=attrs.rows.length;i<l;i++) {
                     let attr = attrs.rows[i]

                     } */
                    return query.rows.map((attr) => {
                        return {
                            'Позиция': attr.POSITION,
                            'Атрибут': attr.COLUMN_NAME
                        }
                    })
                }
                constrs.push({
                    'Имя': constr.CONSTRAINT_NAME,
                    'Наименование (RU)': names.RU,
                    'Наименование (UK)': names.UK,
                    'Тип': [
                        'Уникальность',
                        'Первичный ключ',
                        'Проверка',
                        '?',
                        '?',
                        'Обязательность',
                        'Неизменяемость'
                    ][constr.CONSTRAINT_TYPE],
                    'Использовать для разрешения ссылок': !!constr.LINKS_SIGN,
                    'Текст ограничения': constr.CONSTRAINT_TEXT,
                    'Сообщение при нарушениии': {
                        'Мнемокод': constr.MES_CODE,
                        'Технология производства': ['Стандарт', 'Конструктор'][constr.MES_TECHNOLOGY],
                        'Тип': ['Сообщение ограничения', 'Сообщение исключения'][constr.MES_KIND],
                        'Текст (RU)': messages.RU,
                        'Текст (UK)': messages.UK
                    },
                    'Атрибуты': {
                        'Атрибут': await getConstrAttrs(constr.RN)
                    }
                })
            }
            return constrs
        }
        conU('... get class definition')
        let classQuery = await oci.execute(`
             select CL.*,
                    (select I.CODE from SYSIMAGES I where I.RN = CL.SYSIMAGE) as SSYSIMAGE,
                    UA.CODE as SDOCFORM
               from UNITLIST CL, UAMODULES UA
              where CL.RN = :CLASSRN
                and CL.DOCFORM = UA.RN(+)        
        `, [classRn])
        let classRow = classQuery.rows[0]

        let className = await getResources(classRow.RN, 'UNITLIST', 'UNITNAME')

        classObject = {
            'Код': classRow.UNITCODE,
            'Наименование (RU)': className.RU,
            'Наименование (UK)': className.UK,
            'Абстрактный': !!classRow.ABSTRACT,
            'Буферный': !!classRow.SIGN_BUFFER,
            'Ведомый': !!classRow.SIGN_DRIVEN,
            'Ведущий раздел': classRow.HOSTCODE,
            'Деление': ['Нет деления', 'По версиям', 'По организациям'][classRow.SIGN_SHARE],
            'Юридические лица': !!classRow.SIGN_JURPERS,
            'Иерархия': !!classRow.HIERARCHICAL,
            'Каталоги': !!classRow.SIGN_HIER,
            'Свойства документов': !!classRow.USE_DOCPROPS,
            'Присоединенные документы': !!classRow.USE_FILELINKS,
            'Процедура считывания значений атрибутов': classRow.GET_PROCEDURE,
            'Форма раздела': classRow.SDOCFORM,
            'Пиктограмма': classRow.SSYSIMAGE,
            'Таблица': classRow.TABLE_NAME ? await getTableObj(classRow.TABLE_NAME) : null,
            'Атрибуты': {
                'Атрибут': await getAttribs()
            },
            'Ограничения': {
                'Ограничение': await getConstraints()
            }
        }
        return classObject
    }
    conE(`Processing class ${classCode}...`)
    let classRn = await getClassRn(classCode)
    let classDir = dir + '/' + classCode
    await saveIcons()
    let domainTable = await createDomainsTable()
    let classTable = await createClassTable()
    let tomlContent = {
        'Используемые домены': {
            'Домен': domainTable
        },
        'Класс': classTable
    }
    fs.ensureDirSync(classDir)
    await fs.writeFile(classDir + '\\Metadata.toml', tomlify(tomlContent, null, 4))
    conU('  ...done')
}

const getResources = async (rn, tab, col) => {
    let res = {
        RU: null,
        UK: null
    }

    let r = await oci.execute(`
        select RESOURCE_LANG,
               RESOURCE_TEXT
          from RESOURCES
         where TABLE_NAME = :ATAB
           and RESOURCE_NAME = :ACOL
           and TABLE_ROW = :ANRN
    `,
        {
            ATAB: tab,
            ACOL: col,
            ANRN: rn
        })
    for (let i = 0, len = r.rows.length; i < len; i++) {
        if (r.rows[i].RESOURCE_LANG === 'RUSSIAN') res.RU = (r.rows[i].RESOURCE_TEXT)
        if (r.rows[i].RESOURCE_LANG === 'UKRAINIAN') res.UK = (r.rows[i].RESOURCE_TEXT)
    }
    return res
}

const con = (m) => {
    process.stdout.write(m)
}

const conE = (m) => {
    process.stdout.write(m + '\n')
}

const askParams = async () => {
    let params = {}
    program
        .arguments('<class>')
        .option('-b, --dbname <dbname>', 'The database alias from tnsnames.ora')
        .option('-u, --username <username>', 'The user to authenticate as')
        .option('-p, --password <password>', 'The user\'s password')
        .option('-d, --directory <directory>', 'The directory to save metadata')
        .parse(process.argv)
    params.dbname = program.dbname ||
        (await inquirer.prompt({
            type: 'input',
            message: 'The database alias from tnsnames.ora:',
            name: 'dbname'
        })).dbname
    params.username = program.username ||
        (await inquirer.prompt({
            type: 'input',
            message: 'The user to connect with database:',
            name: 'username'
        })).username
    params.password = program.password ||
        (await inquirer.prompt({
            type: 'password',
            message: 'The user\'s password:',
            name: 'password'
        })).password
    params.directory = program.directory ||
        (await inquirer.prompt({
            type: 'input',
            message: 'The directory to save metadata:',
            name: 'directory'
        })).directory
    if (program.args.length === 0) {
        // todo: ask for several classes
        program.help()
    } else {
        params.singleClass = program.args[0]
    }
    return params
}

const connectDB = async (dbUser, dbPass, dbName) => {
    con('Connecting to the database…')
    let connect = await oracledb.getConnection({
        user: dbUser,
        password: dbPass,
        connectString: dbName
    })
    conE(' connected!')
    return connect
}

const closeConnection = async () => {
    con('Closing db connection... ')
    let c = await oci.close()
    conE('closed.')
    return c
}

const saveLob = async (lob, path, filename, codepage) => {
    if (lob.type === oracledb.CLOB) {
        if (codepage) {
            lob.setEncoding(codepage)  // set the encoding so we get a 'string' not a 'buffer'  ('windows-1251', 'utf8')
        }
    }
    lob.on('error', (err) => {
        throw err
    })
    lob.on('end', () => {
    })
    lob.on('close', () => {
    })
    fs.ensureDirSync(path)
    let outStream = fs.createWriteStream(`${path}/${filename}`)
    outStream.on('error', (err) => {
        throw err
    })
    lob.pipe(outStream)
}
main()
    .then(() => {
        process.exit(0)
    })
    .catch((e) => {
        conE(e)
        closeConnection()
            .then(() => process.exit(1))
            .catch(() => process.exit(1))
    })

